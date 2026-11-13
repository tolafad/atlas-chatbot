(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    app: $("app"), sidebar: $("sidebar"), scrim: $("scrim"),
    history: $("history"), historyEmpty: $("historyEmpty"), search: $("searchInput"),
    newChat: $("newChatBtn"), topNewChat: $("topNewChatBtn"), brand: $("brandLink"),
    collapse: $("collapseBtn"), openSidebar: $("openSidebarBtn"), clearAll: $("clearAllBtn"),
    title: $("chatTitle"), chat: $("chat"), messages: $("messages"), welcome: $("welcome"),
    form: $("composer"), input: $("input"), send: $("sendBtn"), statusDot: $("statusDot"),
    menu: $("itemMenu"), modal: $("modal"), modalTitle: $("modalTitle"), modalBody: $("modalBody"),
    modalConfirm: $("modalConfirm"), modalCancel: $("modalCancel"), toast: $("toast"),
    apiPanel: $("apiPanel"), apiToggle: $("apiToggle"), apiBody: $("apiBody"), apiCount: $("apiCount"),
    apiLive: $("apiLive"), apiEndpoints: $("apiEndpoints"), apiActivity: $("apiActivity"),
    apiModal: $("apiModal"), apiModalTitle: $("apiModalTitle"), apiModalBody: $("apiModalBody"), apiModalClose: $("apiModalClose"),
  };

  const ICONS = {
    bot: '<svg viewBox="0 0 24 24"><path d="M12 2 3 21h4.2l1.6-3.6h6.4l1.6 3.6H21L12 2Zm-1.8 12.2L12 9.9l1.8 4.3h-3.6Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  };
  const APP_NAME = "Atlas";
  const mobile = window.matchMedia("(max-width: 860px)");

  const state = {
    conversations: [],   // [{id, title, created_at, updated_at}]
    activeId: null,
    controller: null,    // AbortController for the active stream
    menuFor: null,       // conversation id the item menu is open for
  };

  // ======================= API call tracking =======================
  const MAX_CALLS = 50;
  const MAX_BODY_CHARS = 6000;
  const calls = [];   // newest first: {id, method, path, status, startedAt, ms, requestBody, responseBody}
  let callSeq = 0;

  function startCall(method, path, body) {
    const call = { id: ++callSeq, method, path, status: "pending", startedAt: Date.now(), ms: null, requestBody: body ?? null, responseBody: "" };
    calls.unshift(call);
    if (calls.length > MAX_CALLS) calls.pop();
    renderActivity();
    return call;
  }

  function appendResponse(call, text) {
    if (call.responseBody.length < MAX_BODY_CHARS) call.responseBody = (call.responseBody + text).slice(0, MAX_BODY_CHARS);
  }

  function finishCall(call, status) {
    if (status !== undefined) call.status = status;
    call.ms = Date.now() - call.startedAt;
    renderActivity();
    if (!els.apiModal.hidden && els.apiModal.dataset.callId === String(call.id)) showCallDetails(call);
  }

  /** fetch() that records the call in the Activity tab. Returns {res, call}; caller must finishCall(). */
  async function trackedFetch(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const call = startCall(method, path, options.body);
    try {
      const res = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      call.status = res.status;
      renderActivity();
      if (res.status === 401) {
        // Session expired or signed out elsewhere: go to sign-in and come back here afterwards.
        location.href = `/signin?next=${encodeURIComponent(location.pathname)}`;
        throw new Error("Please sign in.");
      }
      return { res, call };
    } catch (err) {
      finishCall(call, err.name === "AbortError" ? "aborted" : "failed");
      throw err;
    }
  }

  async function api(path, options = {}) {
    const { res, call } = await trackedFetch(path, options);
    const text = await res.text().catch(() => "");
    appendResponse(call, text);
    finishCall(call);
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }

  // ======================= Utilities =======================

  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 2600);
  }

  function confirmDialog({ title, body, confirmLabel = "Delete" }) {
    return new Promise((resolve) => {
      els.modalTitle.textContent = title;
      els.modalBody.textContent = body;
      els.modalConfirm.textContent = confirmLabel;
      els.modal.hidden = false;
      els.modalConfirm.focus();
      const done = (result) => {
        els.modal.hidden = true;
        els.modalConfirm.onclick = els.modalCancel.onclick = els.modal.onclick = document.onkeydown = null;
        resolve(result);
      };
      els.modalConfirm.onclick = () => done(true);
      els.modalCancel.onclick = () => done(false);
      els.modal.onclick = (e) => e.target === els.modal && done(false);
      document.onkeydown = (e) => e.key === "Escape" && done(false);
    });
  }

  // ======================= Markdown (escapes HTML first) =======================
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function inline(text) {
    return text
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function renderMarkdown(src) {
    const blocks = [];
    const text = escapeHtml(src).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => {
      blocks.push({ lang: lang || "code", code: code.replace(/\n$/, "") });
      return `\u0000${blocks.length - 1}\u0000`;
    });

    const out = [];
    let list = null, para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join("<br>"))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.type}>`); list = null; } };

    for (const line of text.split("\n")) {
      let m;
      if ((m = line.match(/^\u0000(\d+)\u0000$/))) {
        flushPara(); flushList();
        const { lang, code } = blocks[+m[1]];
        out.push(`<pre><div class="code-head"><span>${lang}</span><button type="button" data-copy-code>Copy</button></div><code>${code}</code></pre>`);
      } else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
        flushPara(); flushList();
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      } else if ((m = line.match(/^\s*[-*]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        const type = /^\s*\d/.test(line) ? "ol" : "ul";
        if (list && list.type !== type) flushList();
        if (!list) list = { type, items: [] };
        list.items.push(m[1]);
      } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
        flushPara(); flushList();
        out.push(`<blockquote>${inline(m[1])}</blockquote>`);
      } else if (!line.trim()) {
        flushPara(); flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara(); flushList();
    return out.join("").replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${blocks[+i].code}</code>`);
  }

  // ======================= Sidebar: history =======================
  function groupLabel(iso) {
    const d = new Date(iso), now = new Date();
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days <= 7) return "Previous 7 days";
    if (days <= 30) return "Previous 30 days";
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  function renderHistory() {
    const q = els.search.value.trim().toLowerCase();
    const items = state.conversations
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    els.history.querySelectorAll(".history-group").forEach((g) => g.remove());
    els.historyEmpty.hidden = items.length > 0;
    els.historyEmpty.innerHTML = q
      ? "No chats match your search."
      : "No conversations yet.<br>Start a new chat to see it here.";

    let group = null, current = null;
    for (const c of items) {
      const label = groupLabel(c.updated_at);
      if (label !== current) {
        current = label;
        group = document.createElement("div");
        group.className = "history-group";
        group.innerHTML = `<p class="history-label">${escapeHtml(label)}</p>`;
        els.history.appendChild(group);
      }
      const row = document.createElement("div");
      row.className = "conv" + (c.id === state.activeId ? " active" : "") + (c.id === state.menuFor ? " menu-open" : "");
      row.dataset.id = c.id;
      row.innerHTML = `
        <a class="conv-link" href="/c/${c.id}" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</a>
        <button class="conv-more" type="button" aria-label="Options for ${escapeHtml(c.title)}">${ICONS.more}</button>`;
      group.appendChild(row);
    }
  }

  async function loadConversations() {
    try {
      state.conversations = await api("/api/conversations");
      renderHistory();
      els.statusDot.className = "status-dot ok";
    } catch {
      els.statusDot.className = "status-dot err";
      toast("Could not load chat history.");
    }
  }

  function upsertConversation(conv) {
    const i = state.conversations.findIndex((c) => c.id === conv.id);
    if (i >= 0) state.conversations[i] = { ...state.conversations[i], ...conv };
    else state.conversations.unshift(conv);
    renderHistory();
  }

  function setTitle(title) {
    els.title.textContent = title || APP_NAME;
    document.title = title ? `${title} · ${APP_NAME}` : `${APP_NAME} · AI Assistant`;
  }

  // ---- Item menu (rename / delete) ----
  function openMenu(id, anchor) {
    state.menuFor = id;
    const r = anchor.getBoundingClientRect();
    els.menu.hidden = false;
    const top = Math.min(r.bottom + 4, window.innerHeight - els.menu.offsetHeight - 8);
    els.menu.style.top = `${top}px`;
    els.menu.style.left = `${Math.min(r.left, window.innerWidth - els.menu.offsetWidth - 8)}px`;
    renderHistory();
  }

  function closeMenu() {
    if (els.menu.hidden) return;
    els.menu.hidden = true;
    state.menuFor = null;
    renderHistory();
  }

  function startRename(id) {
    const row = els.history.querySelector(`.conv[data-id="${id}"]`);
    const conv = state.conversations.find((c) => c.id === id);
    if (!row || !conv) return;
    const input = document.createElement("input");
    input.className = "conv-rename";
    input.value = conv.title;
    input.maxLength = 120;
    row.replaceChildren(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const title = input.value.trim();
      if (save && title && title !== conv.title) {
        try {
          await api(`/api/conversations/${id}`, { method: "PATCH", body: { title } });
          conv.title = title;
          if (id === state.activeId) setTitle(title);
        } catch (err) { toast(err.message); }
      }
      renderHistory();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  async function deleteConversation(id) {
    const conv = state.conversations.find((c) => c.id === id);
    if (!conv) return;
    const ok = await confirmDialog({ title: "Delete chat?", body: `This will permanently delete “${conv.title}”.` });
    if (!ok) return;
    try {
      if (id === state.activeId) stopStreaming();
      await api(`/api/conversations/${id}`, { method: "DELETE" });
      state.conversations = state.conversations.filter((c) => c.id !== id);
      if (id === state.activeId) newChat();
      else renderHistory();
      toast("Chat deleted.");
    } catch (err) { toast(err.message); }
  }

  async function deleteAll() {
    if (!state.conversations.length) return toast("There are no chats to delete.");
    const ok = await confirmDialog({
      title: "Delete all chats?",
      body: `This will permanently delete all ${state.conversations.length} conversations.`,
      confirmLabel: "Delete all",
    });
    if (!ok) return;
    try {
      stopStreaming();
      await api("/api/conversations", { method: "DELETE" });
      state.conversations = [];
      newChat();
      toast("All chats deleted.");
    } catch (err) { toast(err.message); }
  }

  // ---- Sidebar visibility ----
  function toggleSidebar(open) {
    if (mobile.matches) {
      els.app.classList.toggle("mobile-open", open ?? !els.app.classList.contains("mobile-open"));
    } else {
      const collapsed = !(open ?? els.app.classList.contains("collapsed"));
      els.app.classList.toggle("collapsed", collapsed);
      try { localStorage.setItem("atlas.sidebarCollapsed", collapsed ? "1" : "0"); } catch { /* ignore */ }
    }
  }
  const closeMobileSidebar = () => els.app.classList.remove("mobile-open");

  // ======================= Conversation view =======================
  function scrollToBottom() { els.chat.scrollTop = els.chat.scrollHeight; }

  function addMessage(role, content = "") {
    els.welcome.hidden = true;
    const msg = document.createElement("div");
    msg.className = `msg ${role === "user" ? "user" : "bot"}`;
    msg.innerHTML = role === "user"
      ? `<div class="bubble-wrap"><div class="bubble"></div>
           <div class="msg-actions"><button type="button" data-copy-msg>${ICONS.copy}Copy</button></div></div>`
      : `<div class="avatar">${ICONS.bot}</div>
         <div class="bubble-wrap"><div class="bubble"></div>
           <div class="msg-actions"><button type="button" data-copy-msg>${ICONS.copy}Copy</button></div></div>`;
    const bubble = msg.querySelector(".bubble");
    if (role === "user") bubble.textContent = content;
    else bubble.innerHTML = content ? renderMarkdown(content) : '<div class="typing"><span></span><span></span><span></span></div>';
    msg.dataset.raw = content;
    els.messages.appendChild(msg);
    return msg;
  }

  function showWelcome() {
    els.messages.innerHTML = "";
    els.welcome.hidden = false;
  }

  function newChat({ push = true } = {}) {
    stopStreaming();
    state.activeId = null;
    showWelcome();
    setTitle(null);
    renderHistory();
    if (push && location.pathname !== "/") history.pushState({}, "", "/");
    closeMobileSidebar();
    els.input.focus();
  }

  async function openConversation(id, { push = true } = {}) {
    if (id === state.activeId && !push) return;
    stopStreaming();
    state.activeId = id;
    renderHistory();
    closeMobileSidebar();
    if (push) history.pushState({}, "", `/c/${id}`);

    els.welcome.hidden = true;
    els.messages.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const conv = await api(`/api/conversations/${id}`);
      if (state.activeId !== id) return; // user navigated away meanwhile
      setTitle(conv.title);
      els.messages.innerHTML = "";
      if (!conv.messages.length) showWelcome();
      conv.messages.forEach((m) => addMessage(m.role, m.content));
      scrollToBottom();
    } catch {
      if (state.activeId !== id) return;
      toast("That conversation could not be found.");
      state.conversations = state.conversations.filter((c) => c.id !== id);
      newChat();
    }
    els.input.focus();
  }

  function routeFromUrl() {
    const m = location.pathname.match(/^\/c\/([\w-]+)$/);
    if (m) openConversation(m[1], { push: false });
    else newChat({ push: false });
  }

  // ======================= Free plan allowance =======================
  const paywall = $("paywall");
  const planEls = { card: $("planCard"), name: $("planName"), count: $("planCount"), meter: $("planMeter"), fill: $("meterFill"), note: $("planNote") };
  try { state.quota = JSON.parse($("quotaData").textContent); } catch { state.quota = null; }

  const isOutOfMessages = () => state.quota?.plan === "free" && state.quota.remaining <= 0;

  function renderQuota() {
    const q = state.quota;
    if (!q) return;
    const card = planEls.card;
    if (q.plan === "paid") {
      card.className = "plan-card paid";
      planEls.name.textContent = "Pro plan";
      planEls.count.textContent = "";
      planEls.note.textContent = "Unlimited messages.";
    } else {
      const pct = Math.min(100, Math.round((q.used / q.limit) * 100));
      card.className = "plan-card" + (q.remaining <= 0 ? " out" : q.remaining <= 3 ? " low" : "");
      planEls.name.textContent = "Free plan";
      planEls.count.textContent = `${q.used} / ${q.limit}`;
      planEls.fill.style.width = `${pct}%`;
      planEls.meter.setAttribute("aria-valuemax", q.limit);
      planEls.meter.setAttribute("aria-valuenow", q.used);
      planEls.note.textContent = q.remaining <= 0
        ? "No free messages left."
        : `${q.remaining} free message${q.remaining === 1 ? "" : "s"} left.`;
      $("paywallLimit").textContent = q.limit;
    }
    // Swap the composer for the upgrade prompt — but never mid-reply (the Stop button lives in the composer).
    const out = isOutOfMessages();
    if (!state.controller) {
      paywall.hidden = !out;
      els.form.hidden = out;
      document.querySelectorAll(".suggestion").forEach((b) => (b.disabled = out));
    }
  }

  async function refreshQuota() {
    try { state.quota = (await api("/api/auth/me")).quota; } catch { /* keep last known */ }
    renderQuota();
  }

  // ======================= Sending & streaming =======================
  function setBusy(busy) {
    els.send.classList.toggle("busy", busy);
    els.send.setAttribute("aria-label", busy ? "Stop generating" : "Send message");
    els.send.disabled = !busy && !els.input.value.trim();
  }

  function stopStreaming() {
    if (state.controller) state.controller.abort();
  }

  function autoResize() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 220) + "px";
    if (!state.controller) els.send.disabled = !els.input.value.trim();
  }

  async function send(text) {
    text = text.trim();
    if (!text || state.controller) return;
    if (isOutOfMessages()) return renderQuota();

    // Lazily create the conversation on the first message.
    if (!state.activeId) {
      try {
        const conv = await api("/api/conversations", { method: "POST" });
        state.activeId = conv.id;
        upsertConversation(conv);
        history.pushState({}, "", `/c/${conv.id}`);
      } catch (err) { return toast(err.message); }
    }
    const cid = state.activeId;

    els.input.value = "";
    autoResize();
    const userMsg = addMessage("user", text);
    const botMsg = addMessage("assistant");
    const bubble = botMsg.querySelector(".bubble");
    scrollToBottom();

    const controller = new AbortController();
    state.controller = controller;
    setBusy(true);
    let reply = "", failed = false, aborted = false, quotaHit = false, call = null;

    try {
      const tracked = await trackedFetch(`/api/conversations/${cid}/messages`, {
        method: "POST",
        body: { content: text },
        signal: controller.signal,
      });
      const res = tracked.res;
      call = tracked.call;
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        appendResponse(call, body);
        let data = {};
        try { data = JSON.parse(body); } catch { /* ignore */ }
        if (data.quota) state.quota = data.quota;
        const error = new Error(data.error || `Request failed (${res.status})`);
        error.code = data.code;
        throw error;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      bubble.classList.add("streaming");

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          appendResponse(call, line + "\n");
          const evt = JSON.parse(line);
          if (evt.type === "quota") {
            state.quota = evt.quota;
            renderQuota();
          } else if (evt.type === "title") {
            upsertConversation({ id: cid, title: evt.title });
            if (state.activeId === cid) setTitle(evt.title);
          } else if (evt.type === "delta") {
            reply += evt.text;
            const nearBottom = els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 120;
            bubble.innerHTML = renderMarkdown(reply);
            if (nearBottom) scrollToBottom();
          } else if (evt.type === "stop" && evt.reason === "max_tokens") {
            reply += "\n\n*— Response truncated (token limit reached).*";
          } else if (evt.type === "error") {
            throw new Error(evt.message);
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError") aborted = true;
      else if (err.code === "free_limit_reached") {
        failed = quotaHit = true;   // not an error: show the upgrade prompt instead of a red bubble
      } else {
        failed = true;
        botMsg.classList.add("error");
        bubble.textContent = err.message || "Something went wrong.";
        els.statusDot.className = "status-dot err";
      }
    } finally {
      if (call) finishCall(call, aborted ? "aborted" : undefined);
      bubble.classList.remove("streaming");
      if (state.controller === controller) state.controller = null;
      setBusy(false);
    }

    const stillHere = state.activeId === cid;
    if (reply && !failed) {
      if (stillHere) { bubble.innerHTML = renderMarkdown(reply); botMsg.dataset.raw = reply; }
      els.statusDot.className = "status-dot ok";
    } else if (stillHere) {
      // Server discarded the unanswered message; mirror that in the UI and give the text back.
      userMsg.remove();
      if (!failed || quotaHit) botMsg.remove();
      if (!els.input.value) { els.input.value = text; autoResize(); }
      if (!els.messages.querySelector(".msg")) els.welcome.hidden = false;
    }
    if (!reply) {
      const conv = state.conversations.find((c) => c.id === cid);
      if (conv && conv.title !== "New chat" && !els.messages.querySelector(".msg.user") && stillHere) {
        conv.title = "New chat"; setTitle(null);
      }
    }
    upsertConversation({ id: cid, updated_at: new Date().toISOString() });
    if (aborted && !reply && stillHere) toast("Stopped.");
    // No reply means the server gave the message back; re-sync the counter. Otherwise just redraw.
    if (!reply && !quotaHit) refreshQuota();
    else renderQuota();
  }

  // ======================= API panel =======================
  const EXAMPLE_BODIES = {
    "POST /api/auth/signin": { email: "you@example.com", password: "your-password" },
    "POST /api/auth/signup": { email: "you@example.com", password: "at-least-8-chars" },
    "PATCH /api/conversations/{id}": { title: "My renamed chat" },
    "POST /api/conversations/{id}/messages": { content: "Hello!" },
  };
  let endpoints = [];
  let activeTab = "endpoints";

  const shortPath = (p) => p.replace(/\/api\/conversations\/([0-9a-f]{32})/, (_, id) => `/api/conversations/${id.slice(0, 6)}…`);
  const statusClass = (s) => (s === "pending" ? "pending" : typeof s === "number" && s < 400 ? "ok" : "bad");
  const pretty = (text) => {
    if (!text) return "";
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  };

  function curlFor(method, path, body) {
    const url = `${location.origin}${path}`;
    let cmd = `curl -X ${method} "${url}"`;
    const needsAuth = !/^\/api\/(health|auth\/sign(in|up))$/.test(path);
    // The session cookie is HttpOnly: copy its value from DevTools → Application → Cookies → atlas_session.
    if (needsAuth) cmd += ` \\\n  -b "atlas_session=<your session cookie>"`;
    if (method !== "GET") cmd += ` \\\n  -H "Content-Type: application/json"`;
    if (body !== undefined && body !== null) cmd += ` \\\n  -d '${JSON.stringify(body)}'`;
    if (path.endsWith("/messages")) cmd += " \\\n  -N";
    return cmd;
  }

  function codeBlock(text) {
    return `<pre class="api-code"><button type="button" class="api-code-copy" data-copy-text>Copy</button><code>${escapeHtml(text)}</code></pre>`;
  }

  function openApiModal(titleHtml, bodyHtml, callId = "") {
    els.apiModalTitle.innerHTML = titleHtml;
    els.apiModalBody.innerHTML = bodyHtml;
    els.apiModal.dataset.callId = callId;
    els.apiModal.hidden = false;
  }
  const closeApiModal = () => { els.apiModal.hidden = true; els.apiModal.dataset.callId = ""; };

  function renderEndpoints() {
    els.apiEndpoints.innerHTML = endpoints.length
      ? endpoints.map((e, i) => `
          <li><button type="button" data-endpoint="${i}" title="${escapeHtml(e.description)}">
            <span class="method ${e.method}">${e.method}</span>
            <span class="api-path">${escapeHtml(e.path)}</span>
          </button></li>`).join("")
      : '<li class="api-empty">Could not load endpoints.</li>';
  }

  function renderActivity() {
    els.apiCount.textContent = calls.length;
    els.apiLive.classList.toggle("on", calls.some((c) => c.status === "pending"));
    els.apiActivity.innerHTML = calls.length
      ? calls.map((c) => `
          <li><button type="button" data-call="${c.id}" title="${escapeHtml(c.path)}">
            <span class="method ${c.method}">${c.method}</span>
            <span class="api-path">${escapeHtml(shortPath(c.path))}</span>
            <span class="status ${statusClass(c.status)}">${c.status === "pending" ? "…" : c.status}</span>
            <span class="api-meta">${c.ms == null ? "" : c.ms < 1000 ? `${c.ms}ms` : `${(c.ms / 1000).toFixed(1)}s`}</span>
          </button></li>`).join("")
      : '<li class="api-empty">No calls yet. Use the app and they will appear here.</li>';
  }

  function showEndpointDetails(e) {
    const key = `${e.method} ${e.path}`;
    const body = EXAMPLE_BODIES[key];
    const path = state.activeId ? e.path.replace("{id}", state.activeId) : e.path;
    openApiModal(
      `<span class="method ${e.method}">${e.method}</span>${escapeHtml(e.path)}`,
      `<div class="api-section"><h4>Description</h4><p>${escapeHtml(e.description || "No description.")}</p></div>
       ${body ? `<div class="api-section"><h4>Example body</h4>${codeBlock(JSON.stringify(body, null, 2))}</div>` : ""}
       <div class="api-section"><h4>Try it${state.activeId && e.path.includes("{id}") ? " (uses the open chat's id)" : ""}</h4>${codeBlock(curlFor(e.method, path, body))}</div>`,
    );
  }

  function showCallDetails(c) {
    const when = new Date(c.startedAt).toLocaleTimeString();
    const statusText = c.status === "pending" ? "In progress…" : c.status;
    openApiModal(
      `<span class="method ${c.method}">${c.method}</span>${escapeHtml(c.path)}`,
      `<div class="api-section"><dl class="api-kv">
         <dt>Status</dt><dd class="status ${statusClass(c.status)}">${escapeHtml(String(statusText))}</dd>
         <dt>Started</dt><dd>${escapeHtml(when)}</dd>
         <dt>Duration</dt><dd>${c.ms == null ? "—" : `${c.ms} ms`}</dd>
       </dl></div>
       ${c.requestBody != null ? `<div class="api-section"><h4>Request body</h4>${codeBlock(JSON.stringify(c.requestBody, null, 2))}</div>` : ""}
       <div class="api-section"><h4>Response${c.responseBody.length >= MAX_BODY_CHARS ? " (truncated)" : ""}</h4>
         ${c.responseBody ? codeBlock(c.path.endsWith("/messages") ? c.responseBody.trim() : pretty(c.responseBody)) : "<p>(empty)</p>"}</div>
       <div class="api-section"><h4>Repeat with curl</h4>${codeBlock(curlFor(c.method, c.path, c.requestBody))}</div>`,
      String(c.id),
    );
  }

  function setApiPanelOpen(open) {
    els.apiPanel.classList.toggle("open", open);
    els.apiBody.hidden = !open;
    els.apiToggle.setAttribute("aria-expanded", String(open));
    try { localStorage.setItem("atlas.apiPanelOpen", open ? "1" : "0"); } catch { /* ignore */ }
  }

  function setApiTab(tab) {
    activeTab = tab;
    els.apiBody.querySelectorAll("[data-tab]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    });
    els.apiEndpoints.hidden = tab !== "endpoints";
    els.apiActivity.hidden = tab !== "activity";
  }

  async function loadEndpoints() {
    try { endpoints = await api("/api/endpoints"); } catch { endpoints = []; }
    renderEndpoints();
  }

  els.apiToggle.addEventListener("click", () => setApiPanelOpen(!els.apiPanel.classList.contains("open")));
  els.apiBody.querySelector(".api-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) setApiTab(tab.dataset.tab);
  });
  els.apiEndpoints.addEventListener("click", (e) => {
    const b = e.target.closest("[data-endpoint]");
    if (b) showEndpointDetails(endpoints[+b.dataset.endpoint]);
  });
  els.apiActivity.addEventListener("click", (e) => {
    const b = e.target.closest("[data-call]");
    const call = b && calls.find((c) => c.id === +b.dataset.call);
    if (call) showCallDetails(call);
  });
  els.apiModalClose.addEventListener("click", closeApiModal);
  els.apiModal.addEventListener("click", async (e) => {
    if (e.target === els.apiModal) return closeApiModal();
    const copy = e.target.closest("[data-copy-text]");
    if (!copy) return;
    try {
      await navigator.clipboard.writeText(copy.nextElementSibling.textContent);
      copy.textContent = "Copied!";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    } catch { toast("Copy failed."); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !els.apiModal.hidden) closeApiModal(); });

  // ======================= Events =======================
  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.controller) stopStreaming();
    else send(els.input.value);
  });
  els.input.addEventListener("input", autoResize);
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.form.requestSubmit(); }
  });

  document.querySelectorAll(".suggestion").forEach((btn) => btn.addEventListener("click", () => send(btn.dataset.prompt)));

  [els.newChat, els.topNewChat].forEach((b) => b.addEventListener("click", () => newChat()));
  els.brand.addEventListener("click", (e) => { e.preventDefault(); newChat(); });
  els.collapse.addEventListener("click", () => (mobile.matches ? closeMobileSidebar() : toggleSidebar(false)));
  els.openSidebar.addEventListener("click", () => toggleSidebar(true));
  els.scrim.addEventListener("click", closeMobileSidebar);
  els.clearAll.addEventListener("click", deleteAll);
  $("signOutBtn").addEventListener("click", async () => {
    stopStreaming();
    try { await api("/api/auth/signout", { method: "POST", body: {} }); } catch { /* signing out anyway */ }
    location.replace("/signin");
  });
  els.search.addEventListener("input", renderHistory);

  els.history.addEventListener("click", (e) => {
    const more = e.target.closest(".conv-more");
    const link = e.target.closest(".conv-link");
    if (more) {
      e.preventDefault();
      const id = more.closest(".conv").dataset.id;
      state.menuFor === id ? closeMenu() : openMenu(id, more);
    } else if (link && !e.ctrlKey && !e.metaKey && e.button === 0) {
      e.preventDefault();
      openConversation(link.closest(".conv").dataset.id);
    }
  });

  els.menu.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    const id = state.menuFor;
    closeMenu();
    if (action === "rename") startRename(id);
    if (action === "delete") deleteConversation(id);
  });

  document.addEventListener("click", (e) => {
    if (!els.menu.hidden && !els.menu.contains(e.target) && !e.target.closest(".conv-more")) closeMenu();
  });
  window.addEventListener("resize", closeMenu);
  els.history.addEventListener("scroll", closeMenu);

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); newChat(); }
    if (e.key === "Escape") closeMenu();
  });

  els.messages.addEventListener("click", async (e) => {
    const codeBtn = e.target.closest("[data-copy-code]");
    const msgBtn = e.target.closest("[data-copy-msg]");
    const btn = codeBtn || msgBtn;
    if (!btn) return;
    const text = codeBtn ? codeBtn.closest("pre").querySelector("code").textContent : msgBtn.closest(".msg").dataset.raw;
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.innerHTML;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.innerHTML = original), 1200);
    } catch { toast("Copy failed."); }
  });

  window.addEventListener("popstate", routeFromUrl);

  // ======================= Init =======================
  try { if (localStorage.getItem("atlas.sidebarCollapsed") === "1" && !mobile.matches) els.app.classList.add("collapsed"); } catch { /* ignore */ }
  try { setApiPanelOpen(localStorage.getItem("atlas.apiPanelOpen") === "1"); } catch { setApiPanelOpen(false); }
  renderActivity();
  renderQuota();
  loadEndpoints();
  loadConversations().then(routeFromUrl);
})();
