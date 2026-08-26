// Which release the site presents as current is decided here, at view time.
//
// Every version's changelog entry and "What's New" copy is already on the server
// from the release commit — but a release commit is pushed while its GitHub
// release is still a DRAFT, and /releases/latest (what every Download button
// points at) still hands out the previous build. So the page ships the last
// released version's copy, asks /api/latest-version which release is actually
// published, and only then reveals the newer one. Publishing moves the site with
// no deploy, no workflow, and no one remembering to do anything.
//
// Fails silent by design: endpoint down, offline, JS off, crawler — the page
// keeps what it shipped with, which is the previous release. It can lag; it can
// never announce a version nobody can download.
(function () {
  'use strict';

  // -1 / 0 / 1 over X.Y.Z. Anything unparseable sorts as 0.0.0 rather than NaN.
  function compareVersions(a, b) {
    var x = String(a).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var y = String(b).split('.').map(function (n) { return parseInt(n, 10) || 0; });
    for (var i = 0; i < 3; i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
    }
    return 0;
  }

  function applyToHomepage(latest, entries, root) {
    var p = (root || document).querySelector('[data-whats-new]');
    if (!p) return;
    // Only ever move forward, and only to copy we actually have.
    if (compareVersions(latest, p.getAttribute('data-version') || '0.0.0') <= 0) return;
    var entry = entries && entries[latest];
    if (!entry) return;
    p.textContent = entry;
    p.setAttribute('data-version', latest);
  }

  function applyToChangelog(latest, root) {
    var doc = root || document;
    var articles = doc.querySelectorAll('article[data-version]');
    if (!articles.length) return;
    var badge = doc.querySelector('[data-latest-badge]');
    for (var i = 0; i < articles.length; i++) {
      var v = articles[i].getAttribute('data-version');
      // An entry newer than the last published release is committed but not out.
      articles[i].hidden = compareVersions(v, latest) > 0;
      if (badge && v === latest) {
        var header = articles[i].firstElementChild;
        if (header && badge.parentElement !== header) header.appendChild(badge);
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { compareVersions: compareVersions, applyToHomepage: applyToHomepage, applyToChangelog: applyToChangelog };
    return;
  }

  function run() {
    fetch('/api/latest-version', { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (data) {
        var latest = data && data.version;
        if (!latest || !/^\d+\.\d+\.\d+$/.test(latest)) return;
        applyToChangelog(latest);
        if (!document.querySelector('[data-whats-new]')) return;
        return fetch('/whats-new.json', { credentials: 'omit' })
          .then(function (r) { return r.ok ? r.json() : {}; })
          .then(function (entries) { applyToHomepage(latest, entries); });
      })
      .catch(function () { /* keep what shipped */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
