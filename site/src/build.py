#!/usr/bin/env python3
"""Static generator for the Notivelo marketing site (notiveloapp.com).

Run:  python3 site/src/build.py      (from the repo root; see site/README.md)
Output goes to site/dist (or $SITE_OUT), which is what nginx serves. Never hand-edit
the output -- edit this file and re-run, or the next build silently reverts the change.

Every product claim on this site was verified against the PRODUCTION bundle at
app.notiveloapp.com (command palette entries, settings sections, task-list key
bindings, OneNote import caveats, /api/auth/config) rather than written from
memory. If a claim here can no longer be verified in the app, delete it.
"""

import hashlib
import os
import re
import shutil
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
OUT = os.environ.get("SITE_OUT") or os.path.join(ROOT, "dist")  # build output (git-ignored); the Docker image sets SITE_OUT

APP = "https://app.notiveloapp.com"
SIGNIN = APP + "/login"
# Opens "Create your account" directly (the app reads ?mode=register; ?email= prefills).
SIGNUP = APP + "/login?mode=register"
SITE = "https://notiveloapp.com"
# Confirmed against the iTunes lookup API by bundle id com.devswartz.notivelo.
APPSTORE = "https://apps.apple.com/app/id6831184261"
TODAY = date.today().isoformat()

# Assets under /assets/ are served with a one-year immutable cache, so their
# filenames MUST change when their contents do -- otherwise a CSS fix can never
# reach anyone who has already visited. (This bit us once: a stylesheet edit
# went out and every browser, and Cloudflare, kept serving the old file.)
# Pages reference __CSS__/__JS__, which are substituted with the hashed names.
ASSET_NAMES = {}


def fingerprint(src_path, name):
    """Copy src_path into /assets as name-<hash>.ext and return the public URL."""
    with open(src_path, "rb") as fh:
        data = fh.read()
    digest = hashlib.sha256(data).hexdigest()[:10]
    stem, ext = os.path.splitext(name)
    out_name = f"{stem}.{digest}{ext}"
    out_dir = os.path.join(OUT, "assets")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, out_name), "wb") as fh:
        fh.write(data)
    return f"/assets/{out_name}"

# --------------------------------------------------------------------------
# icons (stroke-based, inherit currentColor)
# --------------------------------------------------------------------------
def ico(d, fill=False):
    attrs = 'fill="currentColor" stroke="none"' if fill else (
        'fill="none" stroke="currentColor" stroke-width="1.7" '
        'stroke-linecap="round" stroke-linejoin="round"')
    return f'<svg viewBox="0 0 24 24" aria-hidden="true" {attrs}>{d}</svg>'

I_BOOK = ico('<path d="M4 5a2 2 0 0 1 2-2h11v18H6a2 2 0 0 1-2-2z"/><path d="M17 3h2a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-2"/><path d="M8 7h5M8 11h5"/>')
I_CHECK = ico('<path d="M9 11l2 2 4-4"/><rect x="3" y="4" width="18" height="16" rx="2"/>')
I_CAL = ico('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>')
I_USERS = ico('<path d="M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1"/><circle cx="9.5" cy="7" r="3"/><path d="M17 11a3 3 0 1 0-2-5.2M21 19v-1a4 4 0 0 0-3-3.8"/>')
I_CLOUD = ico('<path d="M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.7 1.4A3.8 3.8 0 0 0 6.5 19z"/><path d="M12 12v5M9.5 14.5 12 17l2.5-2.5"/>')
I_LOCK = ico('<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>')
I_BOLT = ico('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>')
I_SPARK = ico('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>')
I_IMPORT = ico('<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>')
I_KEY = ico('<rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/>')
I_PHONE = ico('<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>')
I_PRINT = ico('<path d="M7 8V3h10v5"/><rect x="4" y="8" width="16" height="8" rx="2"/><path d="M7 14h10v7H7z"/>')
I_SEARCH = ico('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')
I_APPLE = ico('<path d="M16 3.5c-1.1.1-2.3.8-3 1.6-.6.8-1.1 1.9-.9 3 1.2.1 2.4-.6 3.1-1.4.7-.9 1-2 .8-3.2z"/><path d="M19.3 16.6c-.5 1.2-.8 1.7-1.5 2.7-.9 1.4-2.2 3.1-3.9 3.1-1.4 0-1.8-.9-3.8-.9s-2.4.9-3.8.9c-1.6 0-2.9-1.5-3.8-2.9C-.1 15.6-.6 10 1.9 7.2 3 5.8 4.6 5 6.2 5c1.6 0 2.7.9 4 .9 1.3 0 2.1-.9 4-.9 1.4 0 2.9.8 3.9 2.1-3.5 1.9-2.9 6.8 1.2 8.5z"/>', fill=True)
I_WINDOWS = ico('<path d="M3 5.6 10.2 4.6V11.3H3zM11.4 4.4 21 3v8.3h-9.6zM3 12.5h7.2v6.7L3 18.2zM11.4 12.5H21V21l-9.6-1.3z"/>', fill=True)
I_TAG = ico('<path d="M3 11V4a1 1 0 0 1 1-1h7l9 9-8 8z"/><circle cx="7.5" cy="7.5" r="1.3"/>')

# rail glyphs for the hero mock
R_NOTES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M9 4v16"/></svg>'
R_TASKS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7l2 2 3-3M4 17l2 2 3-3M12 8h8M12 18h8"/></svg>'
R_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>'

# --------------------------------------------------------------------------
# page shell
# --------------------------------------------------------------------------
NAV = [
    ("/features", "Features"),
    ("/download", "Download"),
    ("/guide/", "Guide"),
    ("/support", "Support"),
]

def nav_html(path):
    out = []
    for href, label in NAV:
        cur = ' aria-current="page"' if path.startswith(href) and href != "/" else ""
        out.append(f'<a href="{href}"{cur}>{label}</a>')
    out.append(f'<a class="nav-signin" href="{SIGNIN}">Sign in</a>')
    out.append(f'<a class="btn btn-primary nav-cta" href="{SIGNUP}">Create your account</a>')
    return "\n          ".join(out)


def shell(path, title, desc, body, og_title=None, noindex=False, extra_head=""):
    """Wrap a body in the site chrome. `path` is the public URL path.

    noindex: for pages that must never be indexed (the 404). Such a page gets a
    robots noindex and NO canonical/og:url -- a canonical on an error page tells
    a crawler it is a real, indexable URL, which is exactly wrong.
    """
    canonical = SITE + path
    og_title = og_title or title
    if noindex:
        index_tags = '<meta name="robots" content="noindex">'
    else:
        index_tags = (f'<link rel="canonical" href="{canonical}">\n'
                      f'<meta property="og:url" content="{canonical}">')
    full_title = title if title.startswith("Notivelo") else f"{title} · Notivelo"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{full_title}</title>
<meta name="description" content="{desc}">
{index_tags}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Notivelo">
<meta property="og:title" content="{og_title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="{SITE}/assets/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{og_title}">
<meta name="twitter:description" content="{desc}">
<meta name="twitter:image" content="{SITE}/assets/og-image.png">
<meta name="theme-color" content="#4f46e5">
<link rel="icon" href="/assets/icons/favicon.ico" sizes="any">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">
<link rel="stylesheet" href="__CSS__">
{extra_head}</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-head">
  <div class="wrap">
    <a class="brand" href="/"><img src="/assets/icon.svg" alt="" width="27" height="27">Notivelo</a>
    <button class="menu-btn" type="button" aria-expanded="false" aria-controls="nav">Menu</button>
    <nav class="nav" id="nav">
          {nav_html(path)}
    </nav>
  </div>
</header>
<main id="main">
{body}
</main>
<footer class="site-foot">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <a class="brand" href="/"><img src="/assets/icon.svg" alt="" width="27" height="27">Notivelo</a>
        <p class="lede foot-tag">Notes and tasks, beautifully together.</p>
      </div>
      <div>
        <h4>Product</h4>
        <ul>
          <li><a href="/features">Features</a></li>
          <li><a href="/download">Download</a></li>
          <li><a href="{SIGNUP}">Create an account</a></li>
          <li><a href="{SIGNIN}">Sign in</a></li>
        </ul>
      </div>
      <div>
        <h4>Learn</h4>
        <ul>
          <li><a href="/guide/">Guide</a></li>
          <li><a href="/guide/getting-started">Getting started</a></li>
          <li><a href="/guide/keyboard-shortcuts">Keyboard shortcuts</a></li>
          <li><a href="/guide/import-from-onenote">Import from OneNote</a></li>
        </ul>
      </div>
      <div>
        <h4>Company</h4>
        <ul>
          <li><a href="/support">Support</a></li>
          <li><a href="{APP}/privacy">Privacy</a></li>
          <li><a href="{APP}/terms">Terms</a></li>
        </ul>
      </div>
    </div>
    <div class="foot-base">
      <span>&copy; {date.today().year} Notivelo</span>
      <span>Notivelo is not affiliated with Microsoft or OneNote.</span>
    </div>
  </div>
</footer>
<script src="__JS__" defer></script>
</body>
</html>
"""


def signup_band(heading, sub, ident="signup"):
    return f"""
<section class="signup" id="{ident}">
  <div class="wrap narrow">
    <h2>{heading}</h2>
    <p>{sub}</p>
    <form class="signup-form" action="{SIGNIN}" method="get">
      <input type="hidden" name="mode" value="register">
      <label class="skip" for="{ident}-email">Email address</label>
      <input id="{ident}-email" type="email" name="email" placeholder="you@example.com"
             autocomplete="email" required>
      <button class="btn btn-on-dark btn-lg" type="submit">Create your account</button>
    </form>
    <p class="fineprint">Sign-up is open to everyone. We'll email you a confirmation link to
      click &mdash; it's good for 24 hours &mdash; and then you're straight into your first
      notebook. Read the <a href="{APP}/privacy">privacy notice</a> and
      <a href="{APP}/terms">terms</a>.</p>
  </div>
</section>
"""


# --------------------------------------------------------------------------
# the hero product mock (a faithful recreation of the real three-pane UI)
# --------------------------------------------------------------------------
MOCK = f"""
<div class="hero-shot" role="img"
     aria-label="The Notivelo app: a left rail with Notes, Tasks and Calendar; a notebook called Cafe Website with coloured sections; and a page called Project brief open in the editor.">
  <div class="mock" aria-hidden="true">
    <div class="mock-rail">
      <i class="on">{R_NOTES}Notes</i>
      <i>{R_TASKS}Tasks</i>
      <i>{R_CAL}Calendar</i>
    </div>
    <div class="mock-nb">
      <div class="mock-nbtitle"><b>C</b>Caf&eacute; Website</div>
      <div class="mock-label">Sections</div>
      <div class="mock-sec on"><s class="s-pink"></s>Planning<em>2</em></div>
      <div class="mock-sec"><s class="s-green"></s>Design<em>1</em></div>
      <div class="mock-sec"><s class="s-amber"></s>Launch prep<em>1</em></div>
      <div class="mock-label">Pages</div>
      <div class="mock-sec"><s class="s-grey"></s>Kickoff meeting</div>
      <div class="mock-sec on"><s class="s-grey"></s>Project brief</div>
    </div>
    <div class="mock-main">
      <div class="mock-toolbar">
        <u>Normal</u><u class="on">B</u><u><i>I</i></u><u>U</u>
        <u>&bull;&nbsp;List</u><u>1.</u><u class="on">&#10003; Task</u><u>Table</u><u>Link</u>
      </div>
      <div class="mock-crumb">Caf&eacute; Website &rsaquo; Planning</div>
      <div class="mock-h">&#127919; Project brief</div>
      <div class="mock-meta">Edited just now by you &middot; Vida is here</div>
      <div class="mock-callout"><strong>Goal:</strong> a faster, friendlier website that turns
        visitors into enquiries.</div>
      <div class="mock-sub">Scope</div>
      <ul class="mock-ul">
        <li>New homepage and menu</li>
        <li class="mock-caret">Pricing page</li>
        <li>Contact form and map</li>
      </ul>
      <div class="mock-sub">Next steps</div>
      <div class="mock-task done"><q class="done"></q>Agree the scope<span class="mock-chip">Done</span></div>
      <div class="mock-task"><q></q>Approve the mock-ups<span class="mock-chip">Tue</span></div>
      <div class="mock-task"><q></q>Write and photograph<span class="mock-chip">Vida</span></div>
    </div>
  </div>
</div>
"""

# --------------------------------------------------------------------------
# structured data
# --------------------------------------------------------------------------
# A single SoftwareApplication block for the homepage. Deliberately carries NO
# `offers` and no price: pricing is not decided, and inventing one here would be
# the most visible possible place to get it wrong. Note the consequence -- the
# Software App *rich result* needs offers, aggregateRating or review, so this
# will be read as valid structured data but will not qualify for that rich
# result until pricing exists.
#
# `<script type="application/ld+json">` is a data block, not executable script,
# so the strict CSP (`script-src 'self'`) does not block it -- verified in a
# real browser rather than assumed.
HOME_JSONLD = """<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Notivelo",
  "applicationCategory": "ProductivityApplication",
  "operatingSystem": "Web, Windows, macOS, iOS, Android",
  "url": "https://notiveloapp.com/",
  "image": "https://notiveloapp.com/assets/og-image.png",
  "description": "Notebooks, sections and pages, with tasks that live inside your notes, a calendar and live sharing built in."
}
</script>
"""

# --------------------------------------------------------------------------
# home
# --------------------------------------------------------------------------
HOME = f"""
<section class="hero">
  <div class="wrap">
    <div>
      <h1>Notes and tasks, beautifully together</h1>
      <p class="lede">Notebooks, sections and pages &mdash; the structure you already think in &mdash;
         with real tasks that live inside your notes instead of in a separate app.</p>
      <div class="hero-actions">
        <a class="btn btn-on-dark btn-lg" href="{SIGNUP}">Create your account</a>
        <a class="btn btn-lg btn-outline-light" href="/guide/getting-started">See how it works</a>
      </div>
      <p class="hero-note">Sign-up is open &middot; nothing to install</p>
      <div class="platforms">
        <span>Works in your browser</span>
        <span>Installs on Windows, Mac, iPhone and Android</span>
      </div>
    </div>
    {MOCK}
  </div>
</section>

<section>
  <div class="wrap">
    <div class="sec-head center">
      <p class="eyebrow">The idea</p>
      <h2>Your notes already know what you have to do</h2>
      <p class="lede">In most set-ups the plan lives in one app and the to-do list lives in another,
        so the two drift apart. Notivelo keeps them in one place: tick a task off inside a meeting
        note and it disappears from Today, because it is the same task.</p>
    </div>
    <div class="grid">
      <div class="card">
        <div class="ico">{I_BOOK}</div>
        <h3>Notebooks, sections, pages</h3>
        <p>A simple, familiar hierarchy, with colour-coded section tabs and pages nested
           as deep as you need. Start from a Meeting notes, Project or Daily journal template.</p>
      </div>
      <div class="card">
        <div class="ico">{I_CHECK}</div>
        <h3>Tasks inside the note</h3>
        <p>Turn any line into a task with a due date, an assignee, tags and a team. It stays part
           of the page and also shows up in Today, Upcoming and My&nbsp;Tasks.</p>
      </div>
      <div class="card">
        <div class="ico">{I_CAL}</div>
        <h3>A calendar that is the tasks</h3>
        <p>Month and week views of everything that is due, filtered to you, a team or a tag &mdash;
           not a separate calendar you have to keep in step.</p>
      </div>
      <div class="card">
        <div class="ico">{I_USERS}</div>
        <h3>Written together, live</h3>
        <p>Share a workspace and edit the same page at the same time, with each person's cursor
           visible as they type. Invite people as admins, editors or viewers.</p>
      </div>
      <div class="card">
        <div class="ico">{I_CLOUD}</div>
        <h3>Keeps working offline</h3>
        <p>Pages are kept on your device, so a dropped connection doesn't stop you writing.
           Edits sync when you're back, and you can always download an unsynced copy.</p>
      </div>
      <div class="card">
        <div class="ico">{I_LOCK}</div>
        <h3>Lock the private pages</h3>
        <p>Put a separate password on individual pages, and lock the whole app on a shared
           device. The rest of the workspace carries on as normal.</p>
      </div>
    </div>
  </div>
</section>

<section class="alt">
  <div class="wrap">
    <div class="row">
      <div class="copy">
        <p class="eyebrow">Tasks</p>
        <h2>Plan in prose, work from a list</h2>
        <p>Write the note the way you would anyway. The moment something becomes an action, make
           it a task on the spot &mdash; it keeps its place in the page, so the context never gets
           separated from the job.</p>
        <ul class="ticks">
          <li>Due dates, including repeats like every day, every two weeks or every year</li>
          <li>Assign to a person, a team or a subteam</li>
          <li>Shared tags across the whole workspace</li>
          <li>Today, Upcoming, My&nbsp;Tasks, Team and All&nbsp;tasks views</li>
          <li>Reminders by email, at the due time, or as a daily digest</li>
        </ul>
        <p><a href="/guide/tasks">How tasks work &rarr;</a></p>
      </div>
      <div class="art">
        <p class="art-title">Today</p>
        <div class="mock-task"><q></q>Approve the mock-ups<span class="mock-chip">Design</span></div>
        <div class="mock-task"><q></q>Send the quote to Mara<span class="mock-chip">Overdue</span></div>
        <div class="mock-task done"><q class="done"></q>Book the photographer</div>
        <div class="mock-task"><q></q>Weekly review<span class="mock-chip">Repeats</span></div>
        <p class="art-foot">
          <kbd>J</kbd> <kbd>K</kbd> to move &middot; <kbd>X</kbd> to complete &middot;
          <kbd>D</kbd> for a date &middot; <kbd>A</kbd> to assign
        </p>
      </div>
    </div>

    <div class="row flip">
      <div class="copy">
        <p class="eyebrow">Together</p>
        <h2>One workspace, the right amount of access</h2>
        <p>Invite the people you work with into a shared workspace and edit the same page at once.
           Everyone sees who else is on the page and where their cursor is.</p>
        <ul class="ticks">
          <li>Roles from owner and admin through editor to view-only</li>
          <li>Teams, with subteams, so tasks can belong to a group rather than a person</li>
          <li>Your private notebooks stay private, in the same app</li>
          <li>Page-level locking for the things nobody else should read</li>
        </ul>
        <p><a href="/guide/sharing">Sharing and permissions &rarr;</a></p>
      </div>
      <div class="art">
        <p class="art-title">Members</p>
        <div class="mock-task"><q class="done q-round"></q>Devon<span class="mock-chip">Owner</span></div>
        <div class="mock-task"><q class="done q-round q-pink"></q>Vida<span class="mock-chip">Editor</span></div>
        <div class="mock-task"><q class="q-round"></q>Scott<span class="mock-chip">Viewer</span></div>
        <p class="art-foot">
          Teams: Design &middot; Front of house &middot; Build
        </p>
      </div>
    </div>

    <div class="row">
      <div class="copy">
        <p class="eyebrow">Moving in</p>
        <h2>Bring your OneNote notebooks with you</h2>
        <p>Connect your Microsoft account, choose the notebooks you want and Notivelo copies them
           across in the background. You can watch the import run and cancel it at any point.</p>
        <p>It is an honest import, so it tells you what it cannot carry: OneNote's free-form page
           layout becomes a normal top-to-bottom flow, and password-protected sections are skipped
           because they can't be read.</p>
        <p><a href="/guide/import-from-onenote">What to expect from an import &rarr;</a></p>
      </div>
      <div class="art">
        <p class="art-title">Import from OneNote</p>
        <div class="mock-task"><q class="done"></q>Work notebook<span class="mock-chip">412 pages</span></div>
        <div class="mock-task"><q class="done"></q>Recipes<span class="mock-chip">63 pages</span></div>
        <div class="mock-task"><q></q>Archive 2019<span class="mock-chip">skip</span></div>
        <p class="art-foot">
          Importing&hellip; 2 of 3 notebooks
        </p>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="wrap">
    <div class="sec-head center">
      <p class="eyebrow">Day to day</p>
      <h2>Quick where it matters</h2>
    </div>
    <div class="grid">
      <div class="card">
        <div class="ico">{I_SEARCH}</div>
        <h3>One box for everything</h3>
        <p><kbd>Ctrl</kbd>&nbsp;<kbd>K</kbd> (or <kbd>&#8984;</kbd>&nbsp;<kbd>K</kbd>) searches your
           notes and runs any command in the app from the same place.</p>
      </div>
      <div class="card">
        <div class="ico">{I_BOLT}</div>
        <h3>Hands on the keyboard</h3>
        <p><kbd>N</kbd> for a page, <kbd>Q</kbd> for a task, <kbd>G</kbd>&nbsp;<kbd>T</kbd> for Today.
           Press <kbd>?</kbd> anywhere for the full list.</p>
      </div>
      <div class="card">
        <div class="ico">{I_SPARK}</div>
        <h3>Light, dark and hybrid</h3>
        <p>A hybrid mode keeps the app chrome dark and the page itself light, like paper on a desk.
           Pick an accent colour to go with it.</p>
      </div>
      <div class="card">
        <div class="ico">{I_PHONE}</div>
        <h3>Install it like an app</h3>
        <p>Runs in any modern browser and installs to the dock, Start menu or home screen on
           Windows, Mac, iPhone and Android.</p>
      </div>
      <div class="card">
        <div class="ico">{I_PRINT}</div>
        <h3>Print and PDF</h3>
        <p><kbd>Ctrl</kbd>&nbsp;<kbd>P</kbd> prints the page you're on &mdash; or the task list or
           calendar view you're looking at.</p>
      </div>
      <div class="card">
        <div class="ico">{I_SPARK}</div>
        <h3>Connected apps</h3>
        <p>Let an AI assistant work with your notes, and take the permission away again, from
           Connected&nbsp;apps in settings.</p>
      </div>
    </div>
  </div>
</section>

{signup_band("Start your first notebook", "It takes about a minute, and the guide walks you through the first hour.")}

<section class="tight alt">
  <div class="wrap narrow tx-center">
    <h2 class="h2-sm">New to Notivelo?</h2>
    <p class="lede">The guide covers everything from your first page to importing a decade of
       OneNote and connecting an AI assistant.</p>
    <p><a class="btn btn-ghost" href="/guide/">Read the guide</a></p>
  </div>
</section>
"""

# --------------------------------------------------------------------------
# features page
# --------------------------------------------------------------------------
FEATURES = f"""
<section class="tight">
  <div class="wrap narrow">
    <h1>Everything in Notivelo</h1>
    <p class="lede">A plain list of what the app actually does today. If something here turns out
       not to work the way it's described, <a href="/support">tell us</a> &mdash; that's a bug in
       the page as much as in the app.</p>
  </div>
</section>

<section class="tight alt">
  <div class="wrap">
    <div class="grid">
      <div class="card">
        <div class="ico">{I_BOOK}</div>
        <h3>Writing</h3>
        <ul class="ticks ticks-sm">
          <li>Notebooks &rarr; sections &rarr; pages, with nested pages</li>
          <li>Colour-coded sections and page colours</li>
          <li>Headings, quotes, lists, tables, code blocks with syntax highlighting</li>
          <li>Images, file attachments and links</li>
          <li>An <em>Insert block</em> menu on <kbd>/</kbd></li>
          <li>Outline view for long pages</li>
          <li>Undo and redo, per page</li>
          <li>Templates: Meeting notes, Project, Daily journal</li>
        </ul>
      </div>
      <div class="card">
        <div class="ico">{I_CHECK}</div>
        <h3>Tasks</h3>
        <ul class="ticks ticks-sm">
          <li>Tasks live inside the page they belong to</li>
          <li>Due dates and repeats</li>
          <li>Assign to a person, a team or a subteam</li>
          <li>Shared workspace tags</li>
          <li>Today, Upcoming, My Tasks, Team, All tasks</li>
          <li>Filter by assignee, team, tag and overdue</li>
          <li>Bulk actions on a selection</li>
          <li>Full keyboard control of the list</li>
        </ul>
      </div>
      <div class="card">
        <div class="ico">{I_CAL}</div>
        <h3>Calendar</h3>
        <ul class="ticks ticks-sm">
          <li>Month and week views</li>
          <li>Everything due, or just yours</li>
          <li>Filter by team and tag</li>
          <li>Jump back to today in one click</li>
        </ul>
      </div>
      <div class="card">
        <div class="ico">{I_USERS}</div>
        <h3>Working together</h3>
        <ul class="ticks ticks-sm">
          <li>Live co-editing with visible cursors</li>
          <li>Owner, admin, editor and viewer roles</li>
          <li>Teams and subteams</li>
          <li>Per-workspace membership</li>
        </ul>
      </div>
      <div class="card">
        <div class="ico">{I_LOCK}</div>
        <h3>Privacy and security</h3>
        <ul class="ticks ticks-sm">
          <li>Locked notes behind their own password</li>
          <li>Lock the app on a shared device</li>
          <li>Email verification on sign-up</li>
          <li>Delete your account and see what goes first</li>
        </ul>
      </div>
      <div class="card">
        <div class="ico">{I_CLOUD}</div>
        <h3>Sync and offline</h3>
        <ul class="ticks ticks-sm">
          <li>Pages cached on the device</li>
          <li>Keeps working with no connection</li>
          <li>Download an unsynced copy if sync is stuck</li>
          <li>Workspace backups and exports</li>
        </ul>
      </div>
      <div class="card">
        <div class="ico">{I_IMPORT}</div>
        <h3>Import</h3>
        <ul class="ticks ticks-sm">
          <li>OneNote import over your Microsoft account</li>
          <li>Pick which notebooks come across</li>
          <li>Progress you can watch and cancel</li>
        </ul>
      </div>
      <div class="card">
        <div class="ico">{I_SPARK}</div>
        <h3>Connected apps</h3>
        <ul class="ticks ticks-sm">
          <li>Allow an AI assistant to use your notes</li>
          <li>See what you've connected</li>
          <li>Withdraw access whenever you like</li>
        </ul>
      </div>
      <div class="card">
        <div class="ico">{I_KEY}</div>
        <h3>Getting about</h3>
        <ul class="ticks ticks-sm">
          <li>Command palette on <kbd>Ctrl</kbd>&nbsp;<kbd>K</kbd></li>
          <li>Shortcut sheet on <kbd>?</kbd></li>
          <li>Light, dark, hybrid and system themes</li>
          <li>Accent colours</li>
          <li>Print or save any view as a PDF</li>
          <li>Reminders by email, at the due time, or daily</li>
        </ul>
      </div>
    </div>
  </div>
</section>

{signup_band("Try it on your own notes", "Sign-up is open. Bring a notebook across from OneNote and see how it feels.")}
"""

# --------------------------------------------------------------------------
# guide
# --------------------------------------------------------------------------
GUIDE_PAGES = [
    ("getting-started", "Getting started",
     "Create your account, make your first notebook and your first task in about ten minutes."),
    ("notebooks-sections-pages", "Notebooks, sections and pages",
     "How Notivelo organises writing, and how to keep it tidy once there is a lot of it."),
    ("tasks", "Working with tasks",
     "Turning a line of a note into real work: due dates, repeats, assignees, tags and the task views."),
    ("calendar", "The calendar",
     "Seeing what is due, by month or week, for you or for the whole team."),
    ("sharing", "Sharing and permissions",
     "Invite people into a workspace, choose what they can do, and set up teams."),
    ("import-from-onenote", "Importing from OneNote",
     "How to bring your notebooks across, and exactly what does and doesn't survive the trip."),
    ("offline-and-devices", "Offline and other devices",
     "Installing Notivelo as an app, what happens with no connection, and how sync resolves."),
    ("connected-apps", "Connecting an AI assistant",
     "Letting an assistant read and write your notes, and taking that access away again."),
    ("keyboard-shortcuts", "Keyboard shortcuts",
     "The shortcuts worth learning first, and how to find the rest."),
]

GUIDE_ICONS = {
    "getting-started": I_BOLT, "notebooks-sections-pages": I_BOOK, "tasks": I_CHECK,
    "calendar": I_CAL, "sharing": I_USERS, "import-from-onenote": I_IMPORT,
    "offline-and-devices": I_CLOUD, "connected-apps": I_SPARK, "keyboard-shortcuts": I_KEY,
}

GUIDE_INDEX = f"""
<section class="tight">
  <div class="wrap narrow">
    <p class="eyebrow">Guide</p>
    <h1>Learn Notivelo</h1>
    <p class="lede">Short, practical walkthroughs. Start at the top if you're new; otherwise take
       whichever one you need.</p>
  </div>
</section>
<section class="tight">
  <div class="wrap">
    <div class="grid">
""" + "\n".join(
    f"""      <a class="card" href="/guide/{slug}">
        <div class="ico">{GUIDE_ICONS[slug]}</div>
        <h3>{title}</h3>
        <p>{blurb}</p>
        <p class="more">Read &rarr;</p>
      </a>"""
    for slug, title, blurb in GUIDE_PAGES
) + f"""
    </div>
  </div>
</section>
{signup_band("Ready when you are", "Create an account and follow along with the guide.", "guide-signup")}
"""

GUIDE_BODIES = {}

GUIDE_BODIES["getting-started"] = f"""
<p class="lede">This walks you from a blank account to a notebook with real work in it. Ten minutes,
   give or take.</p>

<h2>1. Create the account</h2>
<ol class="steps">
  <li>
    <h3>Sign up</h3>
    <p>Go to <a href="{SIGNUP}">{SIGNIN.replace('https://','')}</a> and fill in the <strong>Create
       your account</strong> form. You need a name, an email address and a password of at least eight
       characters.</p>
  </li>
  <li>
    <h3>Confirm your email</h3>
    <p>You'll land on a <strong>Check your email</strong> screen: Notivelo has sent you a
       confirmation link, and it's valid for <strong>24 hours</strong>. Click it and you're in.</p>
    <p>If it hasn't arrived after a minute, check spam &mdash; and you can ask for a fresh link
       from the sign-in screen. Accounts that are never confirmed are deleted after seven
       days, so if you leave it too long, just sign up again.</p>
  </li>
</ol>

<h2>2. Make something to write in</h2>
<ol class="steps">
  <li>
    <h3>Create a notebook</h3>
    <p>A notebook is the big container &mdash; one per project, client or part of your life. Use
       <strong>New notebook</strong>, or press <kbd>Ctrl</kbd>&nbsp;<kbd>K</kbd> and type
       &ldquo;new notebook&rdquo;.</p>
  </li>
  <li>
    <h3>Add a section or two</h3>
    <p>Sections are the coloured tabs inside a notebook. For a project, <em>Planning</em>,
       <em>Design</em> and <em>Launch prep</em> is a reasonable start. You can rename and
       recolour them later.</p>
  </li>
  <li>
    <h3>Start a page</h3>
    <p>Press <kbd>N</kbd> for a new page, or start from a template &mdash; <strong>Meeting
       notes</strong>, <strong>Project</strong> or <strong>Daily journal</strong>. The Project
       template gives you a goal, scope, milestones and open questions, which is usually a better
       beginning than an empty page.</p>
  </li>
</ol>

<h2>3. Write the way you normally would</h2>
<p>Type. For anything beyond plain text, press <kbd>/</kbd> to open the <strong>Insert
   block</strong> menu: headings, quotes, lists, tables, code blocks, images and attachments all
   live there. The toolbar along the top does the same job with the mouse.</p>

<div class="note">
  <p><strong>Don't over-organise on day one.</strong> One notebook and a couple of sections is
     plenty. Structure is easier to add once you can see what you actually write about.</p>
</div>

<h2>4. Turn a line into a task</h2>
<ol class="steps">
  <li>
    <h3>Make the task</h3>
    <p>Put the cursor on the line that is really an action and mark it as a task &mdash; from the
       <kbd>/</kbd> menu, the toolbar's Task button, or <kbd>Q</kbd> for a quick one.</p>
  </li>
  <li>
    <h3>Give it a date and an owner</h3>
    <p>A task without a date never surfaces anywhere. Add a due date, and an assignee if someone
       else is doing it.</p>
  </li>
  <li>
    <h3>See it somewhere else</h3>
    <p>Switch to <strong>Tasks</strong> in the left rail (or <kbd>G</kbd> then <kbd>T</kbd> for
       Today). The task you just wrote in a note is there &mdash; the same task, not a copy. Tick
       it off in either place.</p>
  </li>
</ol>

<h2>5. Settle in</h2>
<ul class="ticks">
  <li>Press <kbd>?</kbd> to see the shortcuts. <kbd>Ctrl</kbd>&nbsp;<kbd>K</kbd> is the one to learn first.</li>
  <li>Pick a theme and accent colour in <strong>Settings &rarr; Appearance</strong>.</li>
  <li>Install Notivelo as an app &mdash; see <a href="/guide/offline-and-devices">Offline and other devices</a>.</li>
  <li>Coming from OneNote? Read <a href="/guide/import-from-onenote">Importing from OneNote</a> before you move everything.</li>
</ul>
"""

GUIDE_BODIES["notebooks-sections-pages"] = f"""
<p class="lede">Notivelo uses a simple structure: notebooks hold sections,
   sections hold pages. Here's how to use it without it becoming a filing project.</p>

<h2>The three levels</h2>
<ul class="ticks">
  <li><strong>Notebook</strong> &mdash; one per project, client, or area of life. The thing you'd
      give a shelf to.</li>
  <li><strong>Section</strong> &mdash; the coloured tabs inside. A phase, a topic, a meeting
      series.</li>
  <li><strong>Page</strong> &mdash; where you write. Pages can sit under other pages when one
      note is genuinely part of another.</li>
</ul>

<h2>Starting from a template</h2>
<p>New pages can start from a template instead of a blank sheet:</p>
<ul class="ticks">
  <li><strong>Meeting notes</strong> &mdash; attendees, agenda, notes and action items.</li>
  <li><strong>Project</strong> &mdash; goal, scope, milestones and open questions.</li>
  <li><strong>Daily journal</strong> &mdash; a focus, room for notes, and a short review.</li>
</ul>
<p>The action items in the meeting template are real tasks, so they show up in Today and
   My&nbsp;Tasks the moment you give them a date.</p>

<h2>Writing on a page</h2>
<p>Press <kbd>/</kbd> for the <strong>Insert block</strong> menu. You get headings, normal text,
   quotes, bulleted and numbered lists, tables, code blocks with language highlighting, images,
   attachments and links. Long pages get an <strong>Outline</strong> view so you can jump around
   by heading.</p>
<p>Pages can be given a colour, which is a surprisingly effective way to tell a reference page
   from a working one at a glance.</p>

<div class="note">
  <p><strong>Name pages like you'd search for them.</strong> &ldquo;Supplier call &mdash; 14 Nov&rdquo;
     beats &ldquo;Notes&rdquo;. <kbd>Ctrl</kbd>&nbsp;<kbd>K</kbd> searches titles and content, and
     good titles make it feel instant.</p>
</div>

<h2>Keeping it tidy later</h2>
<ul class="ticks">
  <li>Recolour and reorder sections as a project changes shape.</li>
  <li>Nest pages under a parent rather than making a new section for two notes.</li>
  <li>Make a new notebook when you catch yourself scrolling past whole sections you never open.</li>
  <li>Archive by moving things into an <em>Archive</em> section rather than deleting.</li>
</ul>

<h2>Printing and exporting</h2>
<p><kbd>Ctrl</kbd>&nbsp;<kbd>P</kbd> prints the page you're on, and your browser's print dialog
   will save it as a PDF. Whole-workspace backups and exports live in
   <strong>Settings &rarr; General</strong>.</p>
"""

GUIDE_BODIES["tasks"] = f"""
<p class="lede">A task in Notivelo isn't a separate record that points back at a note. It is a line
   of the note. That one decision is what keeps the plan and the to-do list from drifting apart.</p>

<h2>Making a task</h2>
<p>Three ways, all equivalent:</p>
<ul class="ticks">
  <li>Press <kbd>/</kbd> on a line and pick <strong>Task</strong>.</li>
  <li>Use the <strong>Task</strong> button in the editor toolbar.</li>
  <li>Press <kbd>Q</kbd> anywhere for a quick task.</li>
</ul>

<h2>What a task can carry</h2>
<ul class="ticks">
  <li><strong>A due date</strong>, including repeats &mdash; every day, every two weeks, every
      year, and so on.</li>
  <li><strong>An assignee</strong>: a person, or a team if it belongs to a group rather than an
      individual.</li>
  <li><strong>Tags</strong>, shared across the whole workspace so they mean the same thing
      everywhere.</li>
</ul>

<h2>The views</h2>
<p>Switch to <strong>Tasks</strong> in the left rail. Along the top:</p>
<ul class="ticks">
  <li><strong>Today</strong> &mdash; due today and anything overdue. <kbd>G</kbd> <kbd>T</kbd></li>
  <li><strong>Upcoming</strong> &mdash; what's coming. <kbd>G</kbd> <kbd>U</kbd></li>
  <li><strong>My Tasks</strong> &mdash; assigned to you, whenever they're due. <kbd>G</kbd> <kbd>M</kbd></li>
  <li><strong>Team</strong> &mdash; your team's work. <kbd>G</kbd> <kbd>E</kbd></li>
  <li><strong>All tasks</strong> &mdash; everything, for a clear-out. <kbd>G</kbd> <kbd>A</kbd></li>
</ul>
<p>Each view can be filtered by assignee, team, tag and overdue, and grouped to taste.</p>

<h2>Running the list from the keyboard</h2>
<p>This is the fastest part of the app. With a task list on screen:</p>
<ul class="ticks">
  <li><kbd>J</kbd> / <kbd>K</kbd> or <kbd>&uarr;</kbd> / <kbd>&darr;</kbd> &mdash; move through the list</li>
  <li><kbd>X</kbd> or <kbd>Space</kbd> &mdash; complete the task</li>
  <li><kbd>D</kbd> &mdash; set a due date</li>
  <li><kbd>A</kbd> &mdash; assign it</li>
  <li><kbd>R</kbd> or <kbd>F2</kbd> &mdash; rename it</li>
  <li><kbd>S</kbd> &mdash; select it, to act on several at once</li>
</ul>

<div class="note">
  <p><strong>A weekly pass through All tasks</strong> is worth more than any clever set-up. Dates
     drift; ten minutes on a Friday keeps Today honest.</p>
</div>

<h2>Being reminded</h2>
<p>In <strong>Settings &rarr; Notifications</strong> you can choose email reminders, a nudge at
   the due time, or a daily digest of what's coming. Pick one. Two is noise, and noise gets
   ignored.</p>
"""

GUIDE_BODIES["calendar"] = f"""
<p class="lede">The calendar isn't a second place to keep appointments. It's the same tasks you
   already have, laid out by date.</p>

<h2>Getting there</h2>
<p><strong>Calendar</strong> in the left rail, or <kbd>G</kbd> then <kbd>C</kbd>.</p>

<h2>Month and week</h2>
<p>Month view is for shape &mdash; where the crunch is, which week is empty. Week view is for
   actually working out a few days. Switch between them at the top, and <strong>Go to today</strong>
   brings you back whenever you've scrolled off.</p>

<h2>Filtering</h2>
<ul class="ticks">
  <li><strong>Mine</strong> or <strong>Everyone</strong> &mdash; your own due dates, or the whole
      workspace's.</li>
  <li><strong>Team</strong> &mdash; narrow to one team or subteam.</li>
  <li><strong>Tags</strong> &mdash; show only a particular kind of work.</li>
</ul>

<div class="note">
  <p><strong>If the calendar looks empty, your tasks have no dates.</strong> That's the usual
     cause. Undated tasks are perfectly valid &mdash; they just live in
     <a href="/guide/tasks">My&nbsp;Tasks</a> rather than here.</p>
</div>

<h2>Printing it</h2>
<p><kbd>Ctrl</kbd>&nbsp;<kbd>P</kbd> prints the view you're looking at, filters and all &mdash;
   handy for a wall, or for a meeting where laptops are a distraction.</p>
"""

GUIDE_BODIES["sharing"] = f"""
<p class="lede">Notivelo is built around a workspace: a shared space with its own members,
   notebooks, teams and tags. Private notebooks live in the same app, so you don't need two
   accounts.</p>

<h2>Inviting people</h2>
<p><strong>Settings &rarr; Members</strong> controls who can open the workspace and what they can
   do. Invite by email address; they'll create an account if they don't have one.</p>

<h2>The roles</h2>
<ul class="ticks">
  <li><strong>Owner</strong> &mdash; the workspace belongs to them.</li>
  <li><strong>Admin</strong> &mdash; can manage members and workspace settings.</li>
  <li><strong>Editor</strong> &mdash; can read and write notes and tasks.</li>
  <li><strong>Viewer</strong> &mdash; can read, and nothing else.</li>
</ul>
<p>Give people the least they need. It's easy to raise someone later and awkward to explain a
   deletion.</p>

<h2>Teams</h2>
<p><strong>Settings &rarr; Teams</strong> lets you make groups &mdash; with subteams &mdash; that
   tasks can be assigned to. Useful when a job belongs to <em>Design</em> rather than to a
   particular person, and for the <strong>Team</strong> view in Tasks.</p>

<h2>Editing at the same time</h2>
<p>Open the same page as someone else and you'll both see it update as you type, with their
   cursor visible where they're working. There's no save button and no &ldquo;someone else has
   this open&rdquo; warning, because neither is needed.</p>

<h2>Tags</h2>
<p>Tags are defined per workspace in <strong>Settings &rarr; Tags</strong>, so
   <em>&#64;waiting</em> means the same thing to everyone. Agree on a handful early; a hundred
   ad-hoc tags are worth less than six good ones.</p>

<div class="note">
  <p><strong>Things only you should see</strong> don't need a separate workspace. Keep a private
     notebook, and for the really sensitive pages use locked notes &mdash; see
     <a href="/guide/offline-and-devices">Offline and other devices</a> for locking on a shared
     machine.</p>
</div>
"""

GUIDE_BODIES["import-from-onenote"] = f"""
<p class="lede">Notivelo can copy your OneNote notebooks across over your Microsoft account. This
   page is deliberately honest about what survives, because an import that surprises you is worse
   than one you planned for.</p>

<h2>Running the import</h2>
<ol class="steps">
  <li>
    <h3>Open workspace settings</h3>
    <p>Go to <strong>Settings &rarr; General</strong>, which holds the name, backups and imports
       for the workspace, and choose <strong>Import from OneNote</strong>.</p>
  </li>
  <li>
    <h3>Sign in with Microsoft</h3>
    <p>You'll be sent to Microsoft to sign in and approve access to your notebooks. Notivelo reads
       them; it doesn't change anything in OneNote.</p>
  </li>
  <li>
    <h3>Choose the notebooks</h3>
    <p>You get the list of notebooks on the account. Tick the ones you want. Starting with one
       medium-sized notebook is a good way to see how it feels before committing everything.</p>
  </li>
  <li>
    <h3>Let it run</h3>
    <p>The import runs in the background with progress on screen, and you can cancel it mid-way.
       Big notebooks take a while &mdash; Microsoft limits how fast they can be read, so this is
       patience rather than a problem.</p>
  </li>
</ol>

<h2>What doesn't come across</h2>
<p>Straight from the app's own warning list:</p>
<ul class="ticks">
  <li><strong>OneNote's free-form page layout becomes a normal top-to-bottom flow.</strong> If you
      used OneNote as a canvas with boxes placed around the page, expect the content to arrive
      in order rather than in position.</li>
  <li><strong>Ink and drawings</strong> come through as images when OneNote provides them, and are
      otherwise skipped.</li>
  <li><strong>Password-protected sections can't be read</strong>, so they're skipped. Unlock them
      in OneNote first if you want them.</li>
  <li><strong>Large notebooks can take a while</strong>, for the rate-limit reason above.</li>
</ul>

<div class="note">
  <p><strong>Keep OneNote around for a bit.</strong> Nothing is removed from Microsoft's side by
     importing, so there's no rush to delete. Give it a fortnight of real use first.</p>
</div>

<h2>Afterwards</h2>
<ul class="ticks">
  <li>Check the notebooks that mattered most, not all of them.</li>
  <li>Recolour sections &mdash; it's the quickest way to make an imported notebook feel like yours.</li>
  <li>Turn the action lines you find into real <a href="/guide/tasks">tasks</a> as you go, rather
      than in one sitting.</li>
</ul>

<p class="muted-note">Notivelo is not affiliated with Microsoft. OneNote
   is a Microsoft product, and the import uses Microsoft's own interface for reading your
   notebooks with your permission.</p>
"""

GUIDE_BODIES["offline-and-devices"] = f"""
<p class="lede">Notivelo runs in the browser, installs like a native app, and keeps working when
   the connection doesn't.</p>

<h2>Installing it</h2>
<p>Open <a href="{APP}">{APP.replace('https://','')}</a> and use your browser's install option:</p>
<ul class="ticks">
  <li><strong>Windows and Mac</strong> &mdash; an install icon in the address bar in Chrome or
      Edge; in Safari, <em>Share &rarr; Add to Dock</em>.</li>
  <li><strong>iPhone and iPad</strong> &mdash; Safari's <em>Share &rarr; Add to Home Screen</em>.</li>
  <li><strong>Android</strong> &mdash; Chrome's menu, <em>Install app</em> or <em>Add to Home
      screen</em>.</li>
</ul>
<p>Installed, it opens in its own window without browser furniture, and keeps your theme and
   accent colour.</p>

<h2>What happens offline</h2>
<p>Your pages are kept on the device, so you can read and write with no connection. Changes queue
   up and sync when you're back, and because editing is built for several people at once, your
   offline edits merge with everyone else's rather than overwriting them.</p>

<h2>When sync looks stuck</h2>
<p>Two escape hatches, both deliberate:</p>
<ul class="ticks">
  <li><strong>Download unsynced copy</strong> &mdash; saves the local version to a file, so your
      work exists outside the app before you try anything else.</li>
  <li><strong>Discard and reload</strong> &mdash; throws away the local copy and takes the
      server's. Only after you've downloaded the copy.</li>
</ul>

<div class="note">
  <p><strong>Download first, always.</strong> The order matters: discarding is not reversible,
     and the download costs you five seconds.</p>
</div>

<h2>On a shared device</h2>
<p><strong>Settings &rarr; Security</strong> lets you lock the app on this device, so it asks for
   your password when you come back to it. The same screen holds <strong>locked notes</strong>:
   individual pages behind their own separate password, which stays locked even while the rest of
   the workspace is open.</p>

<div class="note">
  <p><strong>The locked-notes password is its own password</strong> and resetting your account
     password doesn't recover it. Put it somewhere safe &mdash; a password manager, not a note
     inside Notivelo.</p>
</div>

<h2>Appearance</h2>
<p><strong>Settings &rarr; Appearance</strong> is per device, so your desktop can be dark and your
   phone light. There's a <strong>hybrid</strong> mode too, which keeps the chrome dark and the
   page light &mdash; easier on the eyes without making your writing grey.</p>
"""

GUIDE_BODIES["connected-apps"] = f"""
<p class="lede">You can let an AI assistant work with your Notivelo notes &mdash; look things up,
   draft a page, add tasks &mdash; and withdraw that permission whenever you want.</p>

<h2>What this is</h2>
<p><strong>Settings &rarr; Connected apps</strong> is, in the app's own words, &ldquo;AI assistants
   and other apps you've allowed to use your notes&rdquo;. You approve the connection the same way
   you'd approve any app getting at an account of yours, and the approval is yours to revoke.</p>

<h2>Connecting one</h2>
<ol class="steps">
  <li>
    <h3>Start from the assistant</h3>
    <p>Start from the assistant's own connector or integration settings and add Notivelo there.
       It will send you to Notivelo to sign in.</p>
  </li>
  <li>
    <h3>Approve the access</h3>
    <p>You'll see what's being asked for before you agree. Read it &mdash; this is the moment the
       decision is actually made.</p>
  </li>
  <li>
    <h3>Check it landed</h3>
    <p>The connection appears in <strong>Settings &rarr; Connected apps</strong>. If it isn't
       there, it isn't connected.</p>
  </li>
</ol>

<h2>Sensible limits</h2>
<ul class="ticks">
  <li>Connect to a workspace whose contents you're comfortable sharing with that service.</li>
  <li>Locked notes are a good home for anything you'd rather no assistant ever read.</li>
  <li>Review the list occasionally and remove what you no longer use.</li>
</ul>

<div class="note">
  <p><strong>Revoking is immediate and safe.</strong> Removing a connected app doesn't delete
     anything it created &mdash; the notes and tasks stay yours. It just stops the access.</p>
</div>
"""

GUIDE_BODIES["keyboard-shortcuts"] = f"""
<p class="lede">Notivelo is quick to drive from the keyboard. You don't need all of these &mdash;
   the first two will do more for you than the rest put together.</p>

<h2>The two that matter</h2>
<ul class="ticks">
  <li><kbd>Ctrl</kbd>&nbsp;<kbd>K</kbd> (<kbd>&#8984;</kbd>&nbsp;<kbd>K</kbd> on a Mac) &mdash;
      <strong>search or run a command</strong>. Finds your notes and runs anything the app can do.</li>
  <li><kbd>?</kbd> &mdash; the full, always-current list of shortcuts, without leaving the page.</li>
</ul>

<h2>Getting around</h2>
<ul class="ticks">
  <li><kbd>G</kbd> <kbd>T</kbd> &mdash; Today</li>
  <li><kbd>G</kbd> <kbd>U</kbd> &mdash; Upcoming</li>
  <li><kbd>G</kbd> <kbd>M</kbd> &mdash; My Tasks</li>
  <li><kbd>G</kbd> <kbd>E</kbd> &mdash; Team</li>
  <li><kbd>G</kbd> <kbd>A</kbd> &mdash; All tasks</li>
  <li><kbd>G</kbd> <kbd>C</kbd> &mdash; Calendar</li>
  <li><kbd>Ctrl</kbd>&nbsp;<kbd>\\</kbd> &mdash; show or hide the sidebar</li>
</ul>

<h2>Making things</h2>
<ul class="ticks">
  <li><kbd>N</kbd> &mdash; new page</li>
  <li><kbd>Q</kbd> &mdash; new task</li>
  <li><kbd>/</kbd> &mdash; insert a block while writing</li>
</ul>

<h2>In a task list</h2>
<ul class="ticks">
  <li><kbd>J</kbd> / <kbd>K</kbd> or <kbd>&uarr;</kbd> / <kbd>&darr;</kbd> &mdash; next and previous</li>
  <li><kbd>X</kbd> or <kbd>Space</kbd> &mdash; complete</li>
  <li><kbd>D</kbd> &mdash; due date</li>
  <li><kbd>A</kbd> &mdash; assign</li>
  <li><kbd>R</kbd> or <kbd>F2</kbd> &mdash; rename</li>
  <li><kbd>S</kbd> &mdash; select, for bulk actions</li>
</ul>

<h2>Everywhere</h2>
<ul class="ticks">
  <li><kbd>Ctrl</kbd>&nbsp;<kbd>P</kbd> &mdash; print the page, or the view you're in</li>
  <li><kbd>Ctrl</kbd>&nbsp;<kbd>Z</kbd> / <kbd>Ctrl</kbd>&nbsp;<kbd>Shift</kbd>&nbsp;<kbd>Z</kbd> &mdash; undo and redo</li>
</ul>

<div class="note">
  <p><strong>Mac users:</strong> wherever this page says <kbd>Ctrl</kbd>, use
     <kbd>&#8984;</kbd>. The app works this out for itself and shows the right keys.</p>
</div>
"""


def guide_page(i, slug, title, blurb):
    prev_link = next_link = ""
    if i > 0:
        p = GUIDE_PAGES[i - 1]
        prev_link = f'<a href="/guide/{p[0]}">&larr; {p[1]}</a>'
    else:
        prev_link = '<a href="/guide/">&larr; All guides</a>'
    if i < len(GUIDE_PAGES) - 1:
        n = GUIDE_PAGES[i + 1]
        next_link = f'<a href="/guide/{n[0]}">{n[1]} &rarr;</a>'
    else:
        next_link = f'<a href="{SIGNUP}">Create your account &rarr;</a>'

    body = f"""
<section class="article">
  <div class="wrap narrow">
    <p class="crumbs"><a href="/guide/">Guide</a> &rsaquo; {title}</p>
    <h1>{title}</h1>
    {GUIDE_BODIES[slug]}
    <nav class="page-nav">{prev_link}{next_link}</nav>
  </div>
</section>
{signup_band("Put it into practice", "Sign-up is open, and your first notebook takes a minute.", slug + "-signup")}
"""
    return shell(f"/guide/{slug}", title, blurb, body)


DOWNLOAD = f"""
<section class="tight">
  <div class="wrap narrow">
    <p class="eyebrow">Download</p>
    <h1>Get Notivelo</h1>
    <p class="lede">Notivelo runs in any modern browser &mdash; there's nothing you have to
       install. These are for when you'd rather have it as a proper app in the dock, the Start
       menu or on your home screen.</p>
    <p class="muted-note" id="rel-version">Desktop builds are the current release.</p>
  </div>
</section>

<section class="tight alt">
  <div class="wrap">
    <div class="grid grid-dl">

      <div class="card">
        <div class="ico">{I_PHONE}</div>
        <h3>iPhone and iPad</h3>
        <p>The Notivelo app on the App Store.</p>
        <p><a class="btn btn-primary" href="{APPSTORE}">View on the App Store</a></p>
      </div>

      <div class="card">
        <div class="ico">{I_APPLE}</div>
        <h3>Mac</h3>
        <p>A signed universal build for Apple silicon and Intel.</p>
        <p><a class="btn btn-primary" href="/download/Notivelo-mac.dmg"
              data-size="Notivelo-mac.dmg">Download for Mac</a></p>
        <p class="muted-note">Disk image (.dmg). Open it and drag Notivelo to Applications.</p>
      </div>

      <div class="card">
        <div class="ico">{I_WINDOWS}</div>
        <h3>Windows</h3>
        <p>A standard installer for 64-bit Windows.</p>
        <p><a class="btn btn-primary" href="/download/Notivelo-windows-setup.exe"
              data-size="Notivelo-windows-setup.exe">Download for Windows</a></p>
        <p class="muted-note">Prefer an MSI for deployment?
           <a href="/download/Notivelo-windows.msi" data-size="Notivelo-windows.msi">Get the
           .msi instead</a>.</p>
      </div>

      <div class="card">
        <div class="ico">{I_CLOUD}</div>
        <h3>Browser and Android</h3>
        <p>Open Notivelo in your browser and install it from there &mdash; it keeps working
           offline and opens in its own window, with no store involved.</p>
        <p><a class="btn btn-ghost" href="{APP}">Open Notivelo</a></p>
        <p class="muted-note">See <a href="/guide/offline-and-devices">Offline and other
           devices</a> for the install step on each platform.</p>
      </div>

    </div>
  </div>
</section>

<section class="tight">
  <div class="wrap narrow">
    <h2 class="h2-sm">Which one do I want?</h2>
    <ul class="ticks">
      <li><strong>Just trying it out?</strong> Use the browser. Nothing to install, and
          everything works.</li>
      <li><strong>Using it every day on a computer?</strong> The Mac or Windows app, so it has
          its own window and keeps out of your browser tabs.</li>
      <li><strong>On your phone?</strong> iPhone and iPad have an App Store app; on Android,
          install it from the browser.</li>
    </ul>
    <p>Your notes are the same in all of them &mdash; it's one account, synced.</p>
  </div>
</section>

{signup_band("Need an account first?", "Sign-up is open, and takes about a minute.", "dl-signup")}
"""

# --------------------------------------------------------------------------
# support + 404
# --------------------------------------------------------------------------
SUPPORT = f"""
<section class="tight">
  <div class="wrap narrow">
    <p class="eyebrow">Support</p>
    <h1>Getting help</h1>
    <p class="lede">Most questions are answered in <a href="/guide/">the guide</a>. If yours
       isn't, here's how to reach a person.</p>

    <h2>Email</h2>
    <p>Write to <a href="mailto:support@notiveloapp.com">support@notiveloapp.com</a>. Tell us what
       you expected and what happened instead &mdash; and if it's about a particular page, say
       which notebook and section it's in.</p>

    <h2>From inside the app</h2>
    <p>Press <kbd>Ctrl</kbd>&nbsp;<kbd>K</kbd> and choose <strong>Send feedback</strong>. It's the
       quickest route for a bug, because it already knows what you were looking at.</p>

    <h2>Common questions</h2>
    <dl class="faq">
      <dt>I didn't get the confirmation email.</dt>
      <dd>Check spam first. The link is valid for 24 hours, and you can ask for a new one from
          the sign-in screen. An account that is never confirmed is deleted after seven days, so
          signing up again always works. If nothing arrives at all, email support.</dd>

      <dt>I've forgotten my password.</dt>
      <dd>Use <strong>Forgot password</strong> on the sign-in screen. The reset link works for an
          hour.</dd>

      <dt>I've forgotten my locked-notes password.</dt>
      <dd>That one is separate from your account password, and resetting the account password
          doesn't recover it. Keep it in a password manager.</dd>

      <dt>Is my work saved?</dt>
      <dd>There's no save button &mdash; changes are saved as you type and synced to your other
          devices. If sync looks stuck, use <strong>Download unsynced copy</strong> before
          anything else.</dd>

      <dt>Can I use Notivelo offline?</dt>
      <dd>Yes. See <a href="/guide/offline-and-devices">Offline and other devices</a>.</dd>

      <dt>Will my OneNote notebooks come across?</dt>
      <dd>Mostly &mdash; <a href="/guide/import-from-onenote">the import guide</a> sets out
          exactly what does and doesn't.</dd>

      <dt>How do I delete my account?</dt>
      <dd><strong>Settings &rarr; Profile</strong>. You're shown what will be deleted before you
          confirm it.</dd>
    </dl>

    <h2>Privacy and terms</h2>
    <p>The <a href="{APP}/privacy">privacy notice</a> and <a href="{APP}/terms">terms</a> live in
       the app.</p>
  </div>
</section>
"""

NOTFOUND = """
<section>
  <div class="wrap narrow tx-center">
    <p class="eyebrow">404</p>
    <h1>That page isn't here</h1>
    <p class="lede">The link may be out of date, or we may have moved something.</p>
    <p class="mt-lg">
      <a class="btn btn-primary" href="/">Back to the home page</a>
      <a class="btn btn-ghost" href="/guide/">Read the guide</a>
    </p>
  </div>
</section>
"""

# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------
def write(path, html):
    for token, key in (("__CSS__", "css"), ("__JS__", "js")):
        if token in html:
            html = html.replace(token, ASSET_NAMES[key])
    full = os.path.join(OUT, path.lstrip("/"))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as fh:
        fh.write(html)
    return path


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    # Hashed assets first: the pages need their final URLs.
    ASSET_NAMES["css"] = fingerprint(os.path.join(SRC, "assets", "site.css"), "site.css")
    ASSET_NAMES["js"] = fingerprint(os.path.join(SRC, "assets", "site.js"), "site.js")

    written = []
    written.append(write("index.html", shell(
        "/", "Notivelo &mdash; notes and tasks, beautifully together",
        "Notebooks, sections and pages, with tasks that live inside your notes, a calendar "
        "and live sharing built in. Import your OneNote notebooks and work offline.",
        HOME, og_title="Notivelo: notes and tasks, beautifully together",
        extra_head=HOME_JSONLD)))

    written.append(write("features.html", shell(
        "/features", "Features",
        "Everything Notivelo does today: notebooks and pages, tasks with due dates and "
        "assignees, a calendar, live collaboration, offline working, OneNote import and more.",
        FEATURES)))

    written.append(write("guide/index.html", shell(
        "/guide/", "Guide",
        "Practical walkthroughs for Notivelo: getting started, notebooks and pages, tasks, "
        "the calendar, sharing, importing from OneNote, offline use and keyboard shortcuts.",
        GUIDE_INDEX)))

    for i, (slug, title, blurb) in enumerate(GUIDE_PAGES):
        written.append(write(f"guide/{slug}.html", guide_page(i, slug, title, blurb)))

    written.append(write("download.html", shell(
        "/download", "Download Notivelo",
        "Get Notivelo for Mac, Windows, iPhone and iPad \u2014 or just open it in your browser, "
        "where it installs as an app and works offline.",
        DOWNLOAD)))

    written.append(write("support.html", shell(
        "/support", "Support",
        "How to get help with Notivelo, and answers to the questions that come up most.",
        SUPPORT)))

    written.append(write("404.html", shell(
        "/404", "Page not found", "That page isn't here.", NOTFOUND, noindex=True)))

    # assets
    assets = os.path.join(OUT, "assets")
    os.makedirs(assets, exist_ok=True)
    for name in ("icon.svg", "og-image.png"):
        shutil.copy(os.path.join(SRC, "assets", name), os.path.join(assets, name))
    shutil.copytree(os.path.join(SRC, "assets", "icons"), os.path.join(assets, "icons"))

    # robots + sitemap
    urls = ["/", "/features", "/download", "/support", "/guide/"] + [f"/guide/{s}" for s, _, _ in GUIDE_PAGES]
    sitemap = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        pri = "1.0" if u == "/" else ("0.8" if u in ("/features", "/guide/", "/download") else "0.6")
        sitemap.append(f"  <url><loc>{SITE}{u}</loc><lastmod>{TODAY}</lastmod>"
                       f"<priority>{pri}</priority></url>")
    sitemap.append("</urlset>")
    write("sitemap.xml", "\n".join(sitemap) + "\n")
    write("robots.txt", f"User-agent: *\nAllow: /\n\nSitemap: {SITE}/sitemap.xml\n")

    print(f"built {len(written)} pages + assets into {OUT}")
    for p in written:
        print("  ", p)


if __name__ == "__main__":
    main()
