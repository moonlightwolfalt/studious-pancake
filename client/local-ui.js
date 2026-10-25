/*
 * mopeio-re local UI additions
 *  1. email/password login + registration inside the shop's #loginButtons overlay
 *  2. "BUY ALL" button in the shop header
 *  3. [U] key: ask the local game server for the all-animals upgrade menu
 */
(function () {
  "use strict";
  var API = location.origin + "/accounts";

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function el(tag, props, children) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === "style") e.style.cssText = props[k];
      else if (k === "text") e.textContent = props[k];
      else e[k] = props[k];
    });
    (children || []).forEach(function (c) {
      e.appendChild(c);
    });
    return e;
  }

  function post(path, body) {
    return fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json();
    });
  }

  /** The client restores its session from these keys on load (see login_* in client.js). */
  function storeSession(d, provider) {
    try {
      localStorage.setItem("login_userId", d.userId);
      localStorage.setItem("login_passwordToken", d.token);
      localStorage.setItem("login_name", d.userName);
      localStorage.setItem("login_profilePicURL", d.avatar);
      localStorage.setItem("login_socialNetworkName", provider || "local");
    } catch (e) {}
  }
  function session() {
    try {
      var id = localStorage.getItem("login_userId");
      var token = localStorage.getItem("login_passwordToken");
      return id && token ? { userId: id, token: token } : null;
    } catch (e) {
      return null;
    }
  }

  var CSS =
    "#mopeAuth{background:rgba(0,0,0,.82);border:2px solid #09992f;border-radius:10px;padding:16px;width:300px;" +
    "margin:0 auto;color:#fff;font-family:Arial,sans-serif;text-align:left}" +
    "#mopeAuth h3{margin:0 0 10px;text-align:center;color:#f1c34c}" +
    "#mopeAuth input{width:100%;box-sizing:border-box;margin:4px 0;padding:8px;border-radius:4px;border:0;font-size:15px}" +
    "#mopeAuth .row{display:flex;gap:8px;margin-top:8px}" +
    "#mopeAuth button{flex:1;padding:9px;border:0;border-radius:4px;font-weight:bold;cursor:pointer;font-size:15px;margin:0}" +
    "#mopeAuth .go{background:#09992f;color:#fff}#mopeAuth .alt{background:#444;color:#fff}" +
    "#mopeAuth .err{color:#ff7b7b;min-height:18px;margin-top:6px;font-size:13px;text-align:center}" +
    "#mopeBuyAll{position:absolute!important;top:6px!important;left:490px!important;right:auto!important;z-index:100;" +
    "background:#f1c34c!important;color:#222!important;border:0!important;border-radius:6px!important;height:30px!important;" +
    "padding:0 14px!important;font-weight:bold;cursor:pointer;font-size:14px!important;width:auto!important;min-width:0!important}" +
    "#mopeBuyAll:disabled{opacity:.6;cursor:default}";
  document.head.appendChild(el("style", { text: CSS }));

  function buildAuthForm(host) {
    var mode = "login";
    var title = el("h3", { text: "Log in" });
    var name = el("input", { placeholder: "Username (shown in game)", maxLength: 15, style: "display:none" });
    var email = el("input", { type: "email", placeholder: "Email", autocomplete: "email" });
    var pass = el("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
    var err = el("div", { className: "err" });
    var go = el("button", { className: "go", text: "LOG IN" });
    var alt = el("button", { className: "alt", text: "REGISTER" });

    function setMode(m) {
      mode = m;
      title.textContent = m === "login" ? "Log in" : "Create account";
      name.style.display = m === "login" ? "none" : "block";
      go.textContent = m === "login" ? "LOG IN" : "REGISTER";
      alt.textContent = m === "login" ? "REGISTER" : "BACK";
      pass.autocomplete = m === "login" ? "current-password" : "new-password";
      err.textContent = "";
    }
    alt.onclick = function () {
      setMode(mode === "login" ? "register" : "login");
    };
    go.onclick = function () {
      err.textContent = "";
      go.disabled = true;
      var body = { email: email.value.trim(), password: pass.value };
      if (mode === "register") body.username = name.value.trim();
      post(mode === "login" ? "/auth/login/local" : "/auth/register", body)
        .then(function (res) {
          if (res.success) {
            storeSession(res.data);
            location.reload();
          } else {
            err.textContent = res.error || "Something went wrong";
            go.disabled = false;
          }
        })
        .catch(function () {
          err.textContent = "Account server unreachable";
          go.disabled = false;
        });
    };
    [email, pass, name].forEach(function (i) {
      i.addEventListener("keydown", function (e) {
        e.stopPropagation(); // the game binds WASD/space globally
        if (e.key === "Enter") go.onclick();
      });
      i.addEventListener("keyup", function (e) {
        e.stopPropagation();
      });
    });
    var box = el("div", { id: "mopeAuth" }, [title, name, email, pass, err, el("div", { className: "row" }, [go, alt])]);
    host.appendChild(box);
  }

  function patchLoginOverlay() {
    var host = $("#loginButtons");
    if (!host || host.dataset.mopeLocal) return;
    host.dataset.mopeLocal = "1";
    var social = $(".loginContainer", host);
    if (social) social.style.display = "none";
    buildAuthForm(host);
  }

  function patchShop() {
    var shop = $("#shop_div");
    if (!shop || $("#mopeBuyAll")) return;
    var s = session();
    if (!s) return;
    var btn = el("button", { id: "mopeBuyAll", text: "BUY ALL" });
    btn.onclick = function () {
      if (!confirm("Unlock every skin in the shop for this account?")) return;
      btn.disabled = true;
      btn.textContent = "WORKING...";
      post("/shop/buyall", s)
        .then(function (res) {
          if (res.success) location.reload();
          else {
            btn.textContent = res.error || "FAILED";
          }
        })
        .catch(function () {
          btn.textContent = "FAILED";
        });
    };
    shop.appendChild(btn);
  }

  /* [U]: ask the local game server for the all-animals upgrade menu (custom message 122) */
  document.addEventListener("keydown", function (e) {
    if (e.key !== "u" && e.key !== "U") return;
    var t = e.target && e.target.tagName;
    if (t === "INPUT" || t === "TEXTAREA") return;
    var ws = window.__mopeGameWS;
    if (ws && ws.readyState === 1) ws.send(new Uint8Array([122]).buffer);
  });

  /* rebrand fallback: any "Mistik" text that reaches the DOM becomes "Moonlight Wolf" */
  function rebrand(root) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var n;
    while ((n = w.nextNode())) if (/Mistik/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/Mistik/g, "Moonlight Wolf");
  }

  function tick() {
    rebrand(document.body || document.documentElement);
    patchLoginOverlay();
    patchShop();
  }
  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", tick);
})();
