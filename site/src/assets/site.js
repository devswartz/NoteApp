// Progressive enhancement only: the site is fully usable with this file blocked.
// The nav starts visible in the markup so a no-JS visitor keeps it; below the
// breakpoint we collapse it behind the Menu button once JS is available.
(function () {
  var btn = document.querySelector('.menu-btn');
  var nav = document.getElementById('nav');
  if (!btn || !nav) return;

  var mq = window.matchMedia('(max-width: 860px)');

  function sync() {
    if (mq.matches) {
      nav.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    } else {
      nav.hidden = false;
    }
  }

  btn.addEventListener('click', function () {
    var open = nav.hidden;
    nav.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });

  // Close the menu when a link inside it is followed, so returning via the
  // back button doesn't land on an open overlay.
  nav.addEventListener('click', function (e) {
    if (e.target.closest('a') && mq.matches) sync();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && mq.matches && !nav.hidden) { sync(); btn.focus(); }
  });

  mq.addEventListener ? mq.addEventListener('change', sync) : mq.addListener(sync);
  sync();
})();

// Download page: fill in the current version and each file's size from the
// manifest the mirror script writes. Progressive enhancement -- the links work
// without this, and the page already reads sensibly if the fetch fails.
(function () {
  var versionEl = document.getElementById('rel-version');
  var sized = document.querySelectorAll('[data-size]');
  if (!versionEl && !sized.length) return;

  function human(bytes) {
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB'
                            : Math.round(bytes / 1024) + ' KB';
  }

  fetch('/download/version.json', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) return;
      if (versionEl && data.version) {
        versionEl.textContent = 'Desktop builds are version ' + data.version + '.';
      }
      sized.forEach(function (el) {
        var size = data.files && data.files[el.getAttribute('data-size')];
        if (!size) return;
        var note = document.createElement('span');
        note.className = 'dl-size';
        note.textContent = ' (' + human(size) + ')';
        el.appendChild(note);
      });
    })
    .catch(function () { /* leave the static wording in place */ });
})();
