(() => {
  "use strict";

  const form = document.getElementById("authForm");
  const mode = form.dataset.mode; // "signin" | "signup"
  const errorBox = document.getElementById("authError");
  const submit = document.getElementById("submitBtn");
  const email = document.getElementById("email");
  const password = document.getElementById("password");
  const confirm = document.getElementById("confirm");

  // Only allow redirects back into this site (no "//evil.com" or absolute URLs).
  const params = new URLSearchParams(location.search);
  const rawNext = params.get("next") || "/";
  const next = /^\/(?![\/\\])/.test(rawNext) ? rawNext : "/";

  document.querySelectorAll("[data-keep-next]").forEach((a) => {
    if (next !== "/") a.href += `?next=${encodeURIComponent(next)}`;
  });

  document.querySelectorAll("[data-reveal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(btn.dataset.reveal);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "Hide" : "Show";
      btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
  });

  function showError(message, field) {
    errorBox.textContent = message;
    errorBox.hidden = false;
    form.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
    if (field) { field.classList.add("invalid"); field.focus(); }
  }

  function validate() {
    const e = email.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return showError("Enter a valid email address.", email), false;
    if (mode === "signup") {
      if (password.value.length < 8) return showError("Password must be at least 8 characters.", password), false;
      if (password.value !== confirm.value) return showError("Passwords don't match.", confirm), false;
    } else if (!password.value) {
      return showError("Enter your password.", password), false;
    }
    return true;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    if (!validate()) return;

    submit.disabled = true;
    submit.classList.add("loading");
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.value.trim(), password: password.value }),
      });
      if (res.ok) {
        location.replace(next);
        return;
      }
      const data = await res.json().catch(() => ({}));
      showError(data.error || `Something went wrong (${res.status}).`, res.status === 409 ? email : password);
      if (mode === "signin") password.value = "";
    } catch {
      showError("Couldn't reach the server. Check your connection and try again.");
    }
    submit.disabled = false;
    submit.classList.remove("loading");
  });
})();
