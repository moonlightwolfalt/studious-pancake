/*
 * mopeio-re prelude – runs before client.js.
 *  - redirects every WebSocket aimed at the original game-server fleet
 *    (*.mathstudyguides.com) to the local gateway at /gs/<server-id>
 *  - provides the synchronous master-server lookup used by the patched $config
 */
(function () {
  "use strict";
  var NativeWS = window.WebSocket;
  var wsProto = location.protocol === "https:" ? "wss://" : "ws://";

  function remap(url) {
    try {
      var u = new URL(url, location.href);
      if (/\.mathstudyguides\.com$/i.test(u.hostname)) {
        var id = u.hostname.split(".")[0];
        var path = u.pathname === "/" ? "" : u.pathname; // keep /ping
        return wsProto + location.host + "/gs/" + id + path;
      }
      if (u.protocol === "ws:" || u.protocol === "wss:") {
        // already local – only normalise the scheme to match the page
        if (u.host === location.host) return wsProto + u.host + u.pathname + u.search;
      }
    } catch (e) {}
    return url;
  }

  function LocalWebSocket(url, protocols) {
    var target = remap(String(url));
    if (target !== url) console.log("[mopeio-re] ws", url, "->", target);
    return protocols === undefined ? new NativeWS(target) : new NativeWS(target, protocols);
  }
  LocalWebSocket.prototype = NativeWS.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function (k) {
    Object.defineProperty(LocalWebSocket, k, { value: NativeWS[k] });
  });
  window.WebSocket = LocalWebSocket;

  /** Master server: GET /master/servers (synchronous, runs once at load). */
  window.__mopeLoadServers = function () {
    try {
      var x = new XMLHttpRequest();
      x.open("GET", "/master/servers", false);
      x.send();
      if (x.status === 200) return JSON.parse(x.responseText);
    } catch (e) {
      console.error("[mopeio-re] master server unreachable", e);
    }
    return [];
  };
})();
