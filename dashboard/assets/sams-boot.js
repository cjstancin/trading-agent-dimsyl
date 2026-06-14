// SAMS web connector — drop ONE tag into any webpage to make it a SAMS-connected app:
//
//   <script src="https://<sams-host>/connectors/sams-boot.js"
//           data-sams-id="go" data-sams-name="Go" data-sams-url="https://<sams-host>"></script>
//
// It reports the page's presence/health UP to the SAMS manager and receives commands DOWN
// (dispatched as a `sams:command` CustomEvent the app can listen for). Exposes window.SAMS.
// Zero deps, never throws, fails silent if the conductor is unreachable.
(function () {
  var el = document.currentScript || {};
  var d = el.dataset || {};
  var g = (typeof window !== 'undefined' && window.SAMS_BOOT) || {}; // global config — used when injected/vendored (no data-* attrs reachable)
  var id = d.samsId || g.id || (location.hostname.split('.')[0] || 'web');
  var name = d.samsName || g.name || id;
  var URL = (d.samsUrl || g.url || 'http://localhost:4319').replace(/\/$/, '');
  var showBadge = (d.samsBadge || g.badge) !== 'off';
  var load = 0.12;

  function post(path, body) {
    try { return fetch(URL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(function () {}); }
    catch (e) { return Promise.resolve(); }
  }
  function report(patch) { return post('/report', Object.assign({ id: id, name: name, kind: 'app', status: 'ok', loadScore: load }, patch || {})); }
  function send(to, cmd) { return post('/command', Object.assign({ to: to, from: id }, cmd || {})); }

  async function poll() {
    try {
      var r = await fetch(URL + '/commands/' + id); if (!r.ok) return;
      var j = await r.json(); var cmds = j.commands || [];
      cmds.forEach(function (c) { window.dispatchEvent(new CustomEvent('sams:command', { detail: c })); });
      if (cmds.length) post('/commands/' + id + '/ack', { ids: cmds.map(function (c) { return c.id; }) });
      setConn(true);
    } catch (e) { setConn(false); }
  }

  // light activity signal: bump load briefly on user interaction
  ['click', 'keydown', 'scroll'].forEach(function (ev) { addEventListener(ev, function () { load = 0.3; setTimeout(function () { load = 0.12; }, 4000); }, { passive: true }); });

  var badge;
  function setConn(ok) { if (badge) { badge.style.background = ok ? '#0E1019' : '#1a0e12'; badge.firstChild.style.color = ok ? '#5BFF9B' : '#FF3B5C'; } }
  function makeBadge() {
    if (!showBadge) return;
    badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;display:flex;align-items:center;gap:6px;padding:5px 9px;border-radius:8px;background:#0E1019;border:1px solid #2A3047;font:600 10px/1 ui-monospace,monospace;letter-spacing:.08em;color:#9AA3C7;box-shadow:0 4px 14px rgba(0,0,0,.4);cursor:default';
    var dot = document.createElement('span'); dot.textContent = '●'; dot.style.cssText = 'color:#5BFF9B;text-shadow:0 0 6px currentColor';
    badge.appendChild(dot); badge.appendChild(document.createTextNode(' SAMS'));
    badge.title = 'Connected to SAMS as "' + id + '"';
    (document.body || document.documentElement).appendChild(badge);
  }

  report({ event: { type: 'info', text: 'page opened' } });
  addEventListener('visibilitychange', function () { report({ loadScore: document.hidden ? 0 : load }); });
  addEventListener('pagehide', function () { report({ status: 'offline', loadScore: 0 }); });
  setInterval(function () { report({}); }, 30000);
  setInterval(poll, 10000);
  if (document.body) makeBadge(); else addEventListener('DOMContentLoaded', makeBadge);

  window.SAMS = { report: report, send: send, id: id };
})();
