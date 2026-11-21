//! The Core API against a real server (today's Node server), end to end: register, list
//! workspaces, tree and tasks, write a task, open a page live, edit it, see the edit from a
//! second sign-in and in the server's saved copy, refresh and sign out.
//!
//! Skipped unless NV_TEST_SERVER is set to a server that allows sign-ups and sends no mail, e.g.
//!   PORT=4417 DATA_DIR=<temp> JWT_SECRET=<32+ chars> SIGNUP_MODE=open npx tsx server/index.ts
//!   NV_TEST_SERVER=http://127.0.0.1:4417 cargo test -p nv-core --test server

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use nv_core::*;
use nv_model::yrs::updates::decoder::Decode;
use nv_model::yrs::{
    ReadTxn, Transact, Update, WriteTxn, XmlElementPrelim, XmlFragment, XmlTextPrelim,
};

#[derive(Default)]
struct Events {
    statuses: Mutex<Vec<SyncStatus>>,
    changes: Mutex<Vec<PageInfo>>,
}
impl PageListener for Events {
    fn on_status(&self, s: SyncStatus) {
        self.statuses.lock().unwrap().push(s);
    }
    fn on_change(&self, p: PageInfo) {
        self.changes.lock().unwrap().push(p);
    }
}

#[derive(Default)]
struct LiveEvents {
    statuses: Mutex<Vec<LiveStatus>>,
}
impl LivePageListener for LiveEvents {
    fn on_status(&self, s: LiveStatus) {
        self.statuses.lock().unwrap().push(s);
    }
    fn on_change(&self, _: PageInfo) {}
}

fn wait_for(what: &str, secs: u64, f: impl Fn() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(
            start.elapsed() < Duration::from_secs(secs),
            "timed out waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A Yjs update that adds a paragraph to the end of the page's main fragment.
fn add_paragraph(document: &[u8], fragment: &str, text: &str) -> Vec<u8> {
    let doc = nv_model::doc_from_update(document).unwrap();
    let before = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        let frag = txn.get_or_insert_xml_fragment(fragment);
        let len = frag.len(&txn);
        let p = frag.insert(&mut txn, len, XmlElementPrelim::empty("paragraph"));
        p.push_back(&mut txn, XmlTextPrelim::new(text));
    }
    let u = doc.transact().encode_state_as_update_v1(&before);
    assert!(Update::decode_v1(&u).is_ok());
    u
}

#[test]
fn core_against_a_running_server() {
    let Ok(url) = std::env::var("NV_TEST_SERVER") else {
        eprintln!("skipped: set NV_TEST_SERVER to run against a server");
        return;
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let email = format!("core-test-{stamp}@example.com");
    let password = "correct horse battery staple 1";

    let core = Core::new(url.clone());
    assert_eq!(core.workspaces().unwrap_err(), CoreError::SignedOut);
    let me = core
        .register("Core Test".into(), email.clone(), password.into())
        .unwrap();
    assert!(
        me.user.email_verified,
        "the test server must not need email verification"
    );
    assert!(matches!(
        core.sign_in(email.clone(), "wrong password".into()),
        Err(CoreError::Server { status: 401, .. })
    ));

    // Workspaces, tree, tasks.
    let ws = core.workspaces().unwrap();
    let w = &ws[0];
    assert_eq!(w.role, "owner");
    let tree = core.tree(w.id.clone()).unwrap();
    assert!(
        !tree.notebooks.is_empty() && !tree.pages.is_empty(),
        "a new workspace has its onboarding pages"
    );
    let t = core
        .create_task(w.id.clone(), "From the Rust core".into(), None)
        .unwrap();
    assert!(!t.done);
    assert!(core
        .tasks(w.id.clone())
        .unwrap()
        .iter()
        .any(|x| x.id == t.id));
    assert!(core.set_task_done(t.id.clone(), true).unwrap().done);

    // A page: its saved document, then live.
    let page = &tree.pages[0];
    let saved = read_page(core.page_document(page.id.clone()).unwrap()).unwrap();
    let ev = Arc::new(Events::default());
    let live = core.open_page(page.id.clone(), ev.clone()).unwrap();
    wait_for("sync", 10, || {
        ev.statuses.lock().unwrap().contains(&SyncStatus::Synced)
    });
    assert_eq!(live.info().text, saved.text);
    assert!(!ev.changes.lock().unwrap().is_empty());
    live.announce_presence(true);

    // Edit the page from here.
    let main = live
        .info()
        .boxes
        .first()
        .map(|b| format!("box:{}", b.id))
        .unwrap_or_else(|| "default".into());
    let marker = format!("Written by the Rust core {stamp}");
    live.apply_update(add_paragraph(&live.document(), &main, &marker))
        .unwrap();
    assert!(live.info().text.contains(&marker));

    // A second sign-in (opening the page the newer, non-blocking way) sees it live, and sees
    // the first one's presence.
    let other = Core::new(url.clone());
    other.sign_in(email.clone(), password.into()).unwrap();
    let ev2 = Arc::new(LiveEvents::default());
    let live2 = other.open_live_page(page.id.clone(), ev2.clone()).unwrap();
    wait_for("the second sign-in to sync", 10, || {
        ev2.statuses.lock().unwrap().contains(&LiveStatus::Synced)
    });
    wait_for("the second sign-in to see the edit", 10, || {
        live2.info().text.contains(&marker)
    });
    wait_for("presence", 10, || {
        live2.presence().iter().any(|p| p.contains("Core Test"))
    });

    // ...and its edits reach the first.
    let reply = format!("Reply {stamp}");
    live2
        .apply_update(add_paragraph(&live2.document(), &main, &reply))
        .unwrap();
    wait_for("the server's receipt", 10, || live2.unsent_updates() == 0);
    wait_for("the first sign-in to see the reply", 10, || {
        ev.changes
            .lock()
            .unwrap()
            .iter()
            .any(|p| p.text.contains(&reply))
    });

    // The server saves it (debounced) and indexes it.
    wait_for("the server to save the page", 15, || {
        read_page(core.page_document(page.id.clone()).unwrap())
            .map(|p| p.text.contains(&marker) && p.text.contains(&reply))
            .unwrap_or(false)
    });
    live.close();
    live2.close();
    assert!(matches!(
        ev2.statuses.lock().unwrap().last(),
        Some(LiveStatus::Ended {
            reason: LiveEnd::Closed,
            ..
        })
    ));
    assert_eq!(
        ev.statuses.lock().unwrap().last(),
        Some(&SyncStatus::Closed {
            code: 1000,
            reason: "closed".into()
        })
    );

    // Sessions: restore from the stored refresh token; after sign-out it no longer works.
    let token = core.refresh_token().unwrap();
    let again = Core::new(url.clone());
    assert_eq!(again.restore_session(token).unwrap().user.id, me.user.id);
    let rotated = again.refresh_token().unwrap();
    again.sign_out();
    assert_eq!(
        Core::new(url).restore_session(rotated).unwrap_err(),
        CoreError::SignedOut
    );
}
