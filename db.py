"""SQLite persistence for users, sessions, conversations and messages."""

import hashlib
import os
import secrets
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

DB_PATH = os.getenv("DATABASE_PATH", os.path.join(os.path.dirname(__file__), "data", "chat.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash  TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    plan           TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'paid')),
    messages_used  INTEGER NOT NULL DEFAULT 0    -- messages that counted toward the free allowance
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,              -- SHA-256 of the cookie token; the token itself is never stored
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS login_failures (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    email  TEXT NOT NULL,
    ip     TEXT,
    at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_failures_at ON login_failures(at);
CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT 'New chat',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content          TEXT NOT NULL,
    input_tokens     INTEGER,
    output_tokens    INTEGER,
    created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
"""


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ago(**delta):
    return (datetime.now(timezone.utc) - timedelta(**delta)).isoformat(timespec="seconds")


@contextmanager
def connect():
    # timeout: wait for locks instead of failing — several Gunicorn workers share this file
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _add_column(conn, table, column, ddl):
    """Add a column if it's missing. Returns True if this call added it."""
    if column in {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}:
        return False
    try:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
        return True
    except sqlite3.OperationalError as exc:  # another worker migrated first
        if "duplicate column" not in str(exc):
            raise
        return False


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        # Migrations for databases created by earlier versions of the app.
        _add_column(conn, "conversations", "user_id", "INTEGER REFERENCES users(id) ON DELETE CASCADE")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC)")
        _add_column(conn, "users", "plan", "TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'paid'))")
        if _add_column(conn, "users", "messages_used", "INTEGER NOT NULL DEFAULT 0"):
            # Existing accounts: count the messages they have already sent.
            conn.execute(
                "UPDATE users SET messages_used = (SELECT COUNT(*) FROM messages m "
                "JOIN conversations c ON c.id = m.conversation_id "
                "WHERE c.user_id = users.id AND m.role = 'user')"
            )


# ---------- Users ----------
def create_user(email, password_hash):
    """Create a user. Returns the user dict, or None if the email is taken.
    The very first account also takes ownership of chats created before accounts existed."""
    with connect() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
                (email, password_hash, _now()),
            )
        except sqlite3.IntegrityError:
            return None
        uid = cur.lastrowid
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1:
            conn.execute("UPDATE conversations SET user_id = ? WHERE user_id IS NULL", (uid,))
    return {"id": uid, "email": email, "plan": "free", "messages_used": 0}


def get_user_by_email(email):
    with connect() as conn:
        row = conn.execute("SELECT id, email, password_hash FROM users WHERE email = ?", (email,)).fetchone()
    return dict(row) if row else None


def set_plan(email, plan):
    with connect() as conn:
        cur = conn.execute("UPDATE users SET plan = ? WHERE email = ?", (plan, email))
    return cur.rowcount > 0


# ---------- Message allowance ----------
def get_usage(user_id):
    with connect() as conn:
        row = conn.execute("SELECT plan, messages_used FROM users WHERE id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def reserve_message(user_id, free_limit):
    """Atomically count one message against the allowance.
    Returns False (and counts nothing) if a free account has no messages left."""
    with connect() as conn:
        cur = conn.execute(
            "UPDATE users SET messages_used = messages_used + 1 "
            "WHERE id = ? AND (plan = 'paid' OR messages_used < ?)",
            (user_id, free_limit),
        )
    return cur.rowcount > 0


def refund_message(user_id):
    """Give a message back when the model produced no reply."""
    with connect() as conn:
        conn.execute("UPDATE users SET messages_used = MAX(messages_used - 1, 0) WHERE id = ?", (user_id,))


# ---------- Sessions ----------
def _hash_token(token):
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(user_id, days):
    """Create a session and return the raw token for the cookie."""
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    with connect() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (_now(),))  # housekeeping
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (_hash_token(token), user_id, now.isoformat(timespec="seconds"),
             (now + timedelta(days=days)).isoformat(timespec="seconds")),
        )
    return token


def get_session_user(token):
    if not token:
        return None
    with connect() as conn:
        row = conn.execute(
            "SELECT u.id, u.email, u.plan, u.messages_used FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE s.token_hash = ? AND s.expires_at > ?",
            (_hash_token(token), _now()),
        ).fetchone()
    return dict(row) if row else None


def delete_session(token):
    if token:
        with connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))


# ---------- Sign-in throttling ----------
def record_login_failure(email, ip):
    with connect() as conn:
        conn.execute("DELETE FROM login_failures WHERE at < ?", (_ago(days=1),))
        conn.execute("INSERT INTO login_failures (email, ip, at) VALUES (?, ?, ?)", (email, ip, _now()))


def recent_login_failures(email, ip, minutes):
    """(failures for this email, failures from this IP) in the last `minutes`."""
    since = _ago(minutes=minutes)
    with connect() as conn:
        by_email = conn.execute("SELECT COUNT(*) FROM login_failures WHERE email = ? AND at > ?", (email, since)).fetchone()[0]
        by_ip = conn.execute("SELECT COUNT(*) FROM login_failures WHERE ip = ? AND at > ?", (ip, since)).fetchone()[0]
    return by_email, by_ip


def clear_login_failures(email):
    with connect() as conn:
        conn.execute("DELETE FROM login_failures WHERE email = ?", (email,))


# ---------- Conversations (always scoped to one user) ----------
def list_conversations(user_id):
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def create_conversation(user_id, title="New chat"):
    cid, now = uuid.uuid4().hex, _now()
    with connect() as conn:
        conn.execute(
            "INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (cid, user_id, title, now, now),
        )
    return {"id": cid, "title": title, "created_at": now, "updated_at": now}


def get_conversation(cid, user_id):
    with connect() as conn:
        conv = conn.execute(
            "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?",
            (cid, user_id),
        ).fetchone()
        if not conv:
            return None
        msgs = conn.execute(
            "SELECT id, role, content, input_tokens, output_tokens, created_at "
            "FROM messages WHERE conversation_id = ? ORDER BY id",
            (cid,),
        ).fetchall()
    return {**dict(conv), "messages": [dict(m) for m in msgs]}


def rename_conversation(cid, user_id, title):
    with connect() as conn:
        cur = conn.execute("UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?", (title, cid, user_id))
    return cur.rowcount > 0


def delete_conversation(cid, user_id):
    with connect() as conn:
        cur = conn.execute("DELETE FROM conversations WHERE id = ? AND user_id = ?", (cid, user_id))
    return cur.rowcount > 0


def delete_all_conversations(user_id):
    with connect() as conn:
        conn.execute("DELETE FROM conversations WHERE user_id = ?", (user_id,))


# ---------- Messages (callers must check conversation ownership first) ----------
def add_message(cid, role, content, input_tokens=None, output_tokens=None):
    now = _now()
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO messages (conversation_id, role, content, input_tokens, output_tokens, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (cid, role, content, input_tokens, output_tokens, now),
        )
        conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, cid))
    return cur.lastrowid


def delete_message(message_id):
    with connect() as conn:
        conn.execute("DELETE FROM messages WHERE id = ?", (message_id,))


def get_history(cid, limit):
    """Most recent `limit` messages, oldest first, for sending to the model."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT role, content FROM (SELECT id, role, content FROM messages "
            "WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id",
            (cid, limit),
        ).fetchall()
    return [dict(r) for r in rows]
