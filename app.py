"""General-purpose chatbot: Flask backend streaming replies from Amazon Bedrock (Converse API),
with email/password accounts and per-user conversation history in SQLite."""

import json
import os
import re
from functools import wraps
from urllib.parse import urlsplit

import boto3
import click
from botocore.config import Config
from botocore.exceptions import ClientError, NoCredentialsError
from dotenv import load_dotenv
from flask import (Flask, Response, abort, g, jsonify, redirect, render_template, request,
                   stream_with_context, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

load_dotenv()

import db  # noqa: E402  (reads DATABASE_PATH after .env is loaded)

AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "global.anthropic.claude-opus-4-6-v1")
MAX_TOKENS = int(os.getenv("BEDROCK_MAX_TOKENS", "2048"))
TEMPERATURE = float(os.getenv("BEDROCK_TEMPERATURE", "0.7"))
MAX_HISTORY = 40          # messages sent to the model per request
MAX_MESSAGE_CHARS = 20_000
MAX_TITLE_CHARS = 120

# ---- Authentication settings ----
ALLOW_SIGNUP = os.getenv("ALLOW_SIGNUP", "1") == "1"            # set to 0 to stop new accounts
SESSION_COOKIE = "atlas_session"
SESSION_DAYS = int(os.getenv("SESSION_DAYS", "30"))
COOKIE_SECURE = os.getenv("SESSION_COOKIE_SECURE", "0") == "1"   # set to 1 once the site is served over HTTPS
MIN_PASSWORD, MAX_PASSWORD = 8, 128
LOCKOUT_MINUTES, MAX_FAILS_PER_EMAIL, MAX_FAILS_PER_IP = 15, 5, 30
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
FREE_MESSAGE_LIMIT = int(os.getenv("FREE_MESSAGE_LIMIT", "10"))    # messages per free account
DUMMY_HASH = generate_password_hash("timing-equaliser-not-a-real-password")

SYSTEM_PROMPT = (
    "You are Atlas, a friendly, knowledgeable general-purpose assistant. "
    "Answer clearly and concisely. Use Markdown (headings, lists, code blocks) "
    "when it improves readability."
)

app = Flask(__name__)
db.init_db()

# Same credential chain as test_bedrock.py: ~/.aws/credentials, env vars, SSO cache, instance role, etc.
session = boto3.Session(region_name=AWS_REGION)
bedrock = session.client(
    "bedrock-runtime",
    config=Config(retries={"max_attempts": 5, "mode": "adaptive"}),
)


# ======================= Helpers =======================
def to_converse(history):
    """Convert stored history to Converse format (alternating roles, starts and ends with user)."""
    messages = []
    for item in history:
        if messages and messages[-1]["role"] == item["role"]:
            messages[-1]["content"][0]["text"] += "\n\n" + item["content"]
        else:
            messages.append({"role": item["role"], "content": [{"text": item["content"]}]})
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    return messages


def make_title(text):
    title = " ".join(text.split())
    return title if len(title) <= 50 else title[:50].rsplit(" ", 1)[0] + "…"


def event(payload):
    return json.dumps(payload) + "\n"


def json_body():
    return request.get_json(silent=True) or {}


def quota_for(plan, used):
    """Usage summary the UI shows: free accounts get FREE_MESSAGE_LIMIT messages, paid are unlimited."""
    if plan == "paid":
        return {"plan": "paid", "used": used, "limit": None, "remaining": None}
    return {"plan": "free", "used": min(used, FREE_MESSAGE_LIMIT), "limit": FREE_MESSAGE_LIMIT,
            "remaining": max(FREE_MESSAGE_LIMIT - used, 0)}


def current_quota(user_id):
    usage = db.get_usage(user_id)
    return quota_for(usage["plan"], usage["messages_used"])


# ======================= Auth plumbing =======================
@app.before_request
def load_user_and_check_origin():
    g.user = db.get_session_user(request.cookies.get(SESSION_COOKIE))

    # Cross-site request protection for state-changing API calls:
    # 1) the browser's Origin header (when sent) must be this site;
    # 2) the request must be JSON, which other sites can't send without a CORS preflight we never approve.
    if request.path.startswith("/api/") and request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("Origin")
        if origin and urlsplit(origin).netloc != request.host:
            return jsonify(error="Cross-site request blocked."), 403
        if not request.is_json:
            return jsonify(error="Requests must use Content-Type: application/json."), 415


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    return resp


def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if g.user:
            return view(*args, **kwargs)
        if request.path.startswith("/api/"):
            return jsonify(error="Please sign in."), 401
        return redirect(url_for("signin_page", next=request.full_path.rstrip("?")))
    return wrapper


def start_session(resp, user_id):
    token = db.create_session(user_id, SESSION_DAYS)
    resp.set_cookie(SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True,
                    samesite="Lax", secure=COOKIE_SECURE, path="/")
    return resp


def read_credentials():
    body = json_body()
    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    return email, password


# ======================= Pages =======================
@app.get("/")
@app.get("/c/<conversation_id>")
@login_required
def index(conversation_id=None):
    return render_template("index.html", model_id=MODEL_ID, user=g.user,
                           quota=quota_for(g.user["plan"], g.user["messages_used"]))


@app.get("/signin")
def signin_page():
    if g.user:
        return redirect(url_for("index"))
    return render_template("auth.html", mode="signin", allow_signup=ALLOW_SIGNUP)


@app.get("/signup")
def signup_page():
    if g.user:
        return redirect(url_for("index"))
    if not ALLOW_SIGNUP:
        return redirect(url_for("signin_page"))
    return render_template("auth.html", mode="signup", allow_signup=True)


# ======================= Auth API =======================
@app.post("/api/auth/signup")
def signup():
    """Create an account and sign in. Body: {"email": "...", "password": "..."}"""
    if not ALLOW_SIGNUP:
        return jsonify(error="New accounts are disabled."), 403
    email, password = read_credentials()
    if len(email) > 254 or not EMAIL_RE.match(email):
        return jsonify(error="Enter a valid email address."), 400
    if not MIN_PASSWORD <= len(password) <= MAX_PASSWORD:
        return jsonify(error=f"Password must be {MIN_PASSWORD} to {MAX_PASSWORD} characters."), 400
    user = db.create_user(email, generate_password_hash(password))
    if not user:
        return jsonify(error="An account with this email already exists. Sign in instead."), 409
    return start_session(jsonify(user=user), user["id"]), 201


@app.post("/api/auth/signin")
def signin():
    """Sign in with email and password. Body: {"email": "...", "password": "..."}"""
    email, password = read_credentials()
    ip = request.remote_addr or "unknown"
    by_email, by_ip = db.recent_login_failures(email, ip, LOCKOUT_MINUTES)
    if by_email >= MAX_FAILS_PER_EMAIL or by_ip >= MAX_FAILS_PER_IP:
        return jsonify(error=f"Too many failed attempts. Try again in {LOCKOUT_MINUTES} minutes."), 429

    user = db.get_user_by_email(email) if email else None
    # Always run a hash check so response time doesn't reveal whether the email exists.
    ok = check_password_hash(user["password_hash"] if user else DUMMY_HASH, password) and user is not None
    if not ok:
        db.record_login_failure(email, ip)
        return jsonify(error="Incorrect email or password."), 401
    db.clear_login_failures(email)
    return start_session(jsonify(user={"id": user["id"], "email": user["email"]}), user["id"])


@app.post("/api/auth/signout")
def signout():
    """Sign out: ends this session on the server and clears the cookie."""
    db.delete_session(request.cookies.get(SESSION_COOKIE))
    resp = Response(status=204)
    resp.delete_cookie(SESSION_COOKIE, path="/", samesite="Lax", secure=COOKIE_SECURE, httponly=True)
    return resp


@app.get("/api/auth/me")
@login_required
def me():
    """The signed-in user, their plan and how many free messages are left."""
    return jsonify(user={"id": g.user["id"], "email": g.user["email"]}, quota=current_quota(g.user["id"]))


# ======================= Misc API =======================
@app.get("/api/health")
def health():
    """Check that the server is up and see which model and region it uses. (No sign-in needed.)"""
    return jsonify(status="ok", model=MODEL_ID, region=AWS_REGION)


@app.get("/api/endpoints")
@login_required
def list_endpoints():
    """List every API endpoint this server offers (used by the sidebar API panel)."""
    endpoints = []
    for rule in app.url_map.iter_rules():
        if not rule.rule.startswith("/api/"):
            continue
        doc = (app.view_functions[rule.endpoint].__doc__ or "").strip()
        for method in sorted(rule.methods - {"HEAD", "OPTIONS"}):
            endpoints.append({"method": method, "path": rule.rule.replace("<cid>", "{id}"), "description": doc})
    order = {"GET": 0, "POST": 1, "PATCH": 2, "DELETE": 3}
    endpoints.sort(key=lambda e: (e["path"], order.get(e["method"], 9)))
    return jsonify(endpoints)


# ======================= Conversations (per user) =======================
@app.get("/api/conversations")
@login_required
def list_conversations():
    """List your saved conversations, newest first."""
    return jsonify(db.list_conversations(g.user["id"]))


@app.post("/api/conversations")
@login_required
def create_conversation():
    """Create a new, empty conversation."""
    return jsonify(db.create_conversation(g.user["id"])), 201


@app.delete("/api/conversations")
@login_required
def delete_all_conversations():
    """Delete all of your conversations and their messages."""
    db.delete_all_conversations(g.user["id"])
    return "", 204


@app.get("/api/conversations/<cid>")
@login_required
def get_conversation(cid):
    """Get one of your conversations with all of its messages."""
    conv = db.get_conversation(cid, g.user["id"])
    if not conv:
        abort(404)
    return jsonify(conv)


@app.patch("/api/conversations/<cid>")
@login_required
def rename_conversation(cid):
    """Rename a conversation. Body: {"title": "..."}"""
    title = str(json_body().get("title", "")).strip()[:MAX_TITLE_CHARS]
    if not title:
        return jsonify(error="Title cannot be empty."), 400
    if not db.rename_conversation(cid, g.user["id"], title):
        abort(404)
    return jsonify(id=cid, title=title)


@app.delete("/api/conversations/<cid>")
@login_required
def delete_conversation(cid):
    """Delete one conversation and its messages."""
    if not db.delete_conversation(cid, g.user["id"]):
        abort(404)
    return "", 204


# ======================= Chat =======================
@app.post("/api/conversations/<cid>/messages")
@login_required
def send_message(cid):
    """Send a message and stream the reply as NDJSON lines. Body: {"content": "..."}"""
    uid = g.user["id"]
    conv = db.get_conversation(cid, uid)
    if not conv:
        abort(404)
    content = str(json_body().get("content", "")).strip()
    if not content:
        return jsonify(error="Message cannot be empty."), 400
    content = content[:MAX_MESSAGE_CHARS]

    # Free plan allowance: count this message up front (atomically), give it back if no reply comes.
    if not db.reserve_message(uid, FREE_MESSAGE_LIMIT):
        return jsonify(
            error=f"You've used all {FREE_MESSAGE_LIMIT} free messages. Upgrade to a paid account to keep chatting.",
            code="free_limit_reached",
            quota=current_quota(uid),
        ), 402
    quota = current_quota(uid)

    # Auto-title the conversation from its first message.
    new_title = None
    if not conv["messages"] and conv["title"] == "New chat":
        new_title = make_title(content)
        db.rename_conversation(cid, uid, new_title)

    user_msg_id = db.add_message(cid, "user", content)
    messages = to_converse(db.get_history(cid, MAX_HISTORY))

    def generate():
        reply, usage, ok = [], {}, False
        yield event({"type": "quota", "quota": quota})
        if new_title:
            yield event({"type": "title", "title": new_title})
        try:
            response = bedrock.converse_stream(
                modelId=MODEL_ID,
                system=[{"text": SYSTEM_PROMPT}],
                messages=messages,
                inferenceConfig={"maxTokens": MAX_TOKENS, "temperature": TEMPERATURE},
            )
            for chunk in response["stream"]:
                if "contentBlockDelta" in chunk:
                    text = chunk["contentBlockDelta"]["delta"].get("text")
                    if text:
                        reply.append(text)
                        yield event({"type": "delta", "text": text})
                elif "messageStop" in chunk:
                    yield event({"type": "stop", "reason": chunk["messageStop"].get("stopReason")})
                elif "metadata" in chunk:
                    usage = chunk["metadata"].get("usage", {})
                    yield event({"type": "usage", "usage": usage})
            ok = True
        except NoCredentialsError:
            yield event({"type": "error", "message": "AWS credentials not found. Run: aws configure"})
        except ClientError as exc:
            err = exc.response.get("Error", {})
            app.logger.error("Bedrock error %s: %s", err.get("Code"), err.get("Message"))
            yield event({"type": "error", "message": f"{err.get('Code')}: {err.get('Message')}"})
        except GeneratorExit:
            pass  # client pressed Stop / disconnected; partial reply is saved below
        except Exception:  # noqa: BLE001
            app.logger.exception("Unexpected error while streaming")
            yield event({"type": "error", "message": "Unexpected server error. Check the server logs."})
        finally:
            text = "".join(reply)
            if text:
                db.add_message(cid, "assistant", text, usage.get("inputTokens"), usage.get("outputTokens"))
            elif not ok:
                # Nothing came back: drop the unanswered user turn and refund it so the user can retry.
                db.delete_message(user_msg_id)
                db.refund_message(uid)
                if new_title:
                    db.rename_conversation(cid, uid, "New chat")

    return Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.cli.command("set-plan")
@click.argument("email")
@click.argument("plan", type=click.Choice(["free", "paid"]))
def set_plan_command(email, plan):
    """Admin: switch an account between the free and paid plan (until payments exist).
    Example: uv run flask --app app set-plan you@example.com paid"""
    if db.set_plan(email.strip().lower(), plan):
        click.echo(f"{email} is now on the {plan} plan.")
    else:
        raise click.ClickException(f"No account found for {email}.")


if __name__ == "__main__":
    app.run(debug=os.getenv("FLASK_DEBUG") == "1", port=int(os.getenv("PORT", "5000")), threaded=True)
