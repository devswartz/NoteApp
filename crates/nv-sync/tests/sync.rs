//! nv-sync against a stand-in for today's server: the protocol in memory, then real sockets to an
//! in-process server that behaves like server/collab.ts (tests/support): live editing,
//! reconnecting with backoff, 4401 and token refresh, 4403, closing promptly, and the queue of
//! local edits (sent after a reconnect, kept across a new LiveDoc).

mod support;

use std::collections::BTreeMap;
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nv_sync::yrs::{Doc, ReadTxn, Text, Transact, WriteTxn, XmlFragment};
use nv_sync::{
    AuthError, Backoff, Listener, LiveDoc, Options, Outbox, RemoteHook, Session, Status, SyncDoc,
};
use support::{read_text, type_text, wait_for, TestServer};

/// Deliver every message in `msgs` to `to`, returning its replies.
fn deliver(to: &SyncDoc, msgs: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    msgs.iter()
        .flat_map(|m| to.handle(m).unwrap().replies)
        .collect()
}

#[test]
fn protocol_syncs_both_ways_in_memory() {
    let server = SyncDoc::new(Doc::new());
    type_text(server.doc(), "box:a", "from the server");
    let client = SyncDoc::new(Doc::new());
    type_text(client.doc(), "box:b", "typed offline");

    // Both send step 1; each answers the other's with step 2.
    let to_client = deliver(&server, client.hello());
    let to_server = deliver(&client, server.hello());
    assert!(deliver(&client, to_client).is_empty());
    assert!(deliver(&server, to_server).is_empty());
    for d in [&server, &client] {
        assert_eq!(read_text(d.doc(), "box:a"), "from the server");
        assert_eq!(read_text(d.doc(), "box:b"), "typed offline");
    }

    // A later edit travels as one update message.
    let before = client.state_vector();
    type_text(client.doc(), "box:a", "!");
    let update = client.doc().transact().encode_state_as_update_v1(&before);
    let h = server.handle(&SyncDoc::update_message(update)).unwrap();
    assert!(h.doc_changed && h.replies.is_empty());
    assert_eq!(read_text(server.doc(), "box:a"), "from the server!");

    // A receipt (step 1 again): the answer is a step 2 that changes nothing, even with deletions.
    {
        let mut txn = client.doc().transact_mut();
        let t = txn.get_or_insert_text("t");
        t.push(&mut txn, "abc");
        t.remove_range(&mut txn, 0, 1);
    }
    let to_server = deliver(&server, client.hello());
    deliver(&client, to_server);
    let answer = server.handle(&client.step1()).unwrap().replies;
    let h = client.handle(&answer[0]).unwrap();
    assert!(h.synced && !h.doc_changed, "{h:?}");

    // Presence.
    let m = client.set_presence(r#"{"user":{"name":"Ann"}}"#);
    assert!(server.handle(&m).unwrap().awareness_changed);
    assert!(server.presence().iter().any(|(_, s)| s.contains("Ann")));

    assert!(
        server.handle(&[200]).is_err(),
        "a truncated message is an error"
    );
}

/// Records what it sees around each remote update: the text before, whether it changed, the
/// text after. `skip` doesn't call `apply` (it is applied anyway).
struct Around {
    doc: Doc,
    name: &'static str,
    skip: bool,
    log: Arc<Mutex<Vec<String>>>,
}
impl RemoteHook for Around {
    fn around_remote(&self, apply: &mut dyn FnMut() -> bool) {
        let before = read_text(&self.doc, "box:a");
        let changed = if self.skip { false } else { apply() };
        let after = read_text(&self.doc, "box:a");
        self.log
            .lock()
            .unwrap()
            .push(format!("{}: {before:?} {changed} {after:?}", self.name));
    }
}

#[test]
fn remote_hooks_run_around_each_remote_update_once() {
    let server = SyncDoc::new(Doc::new());
    let client = SyncDoc::new(Doc::new());
    let log = Arc::new(Mutex::new(Vec::new()));
    let hook = |name, skip| {
        Arc::new(Around {
            doc: client.doc().clone(),
            name,
            skip,
            log: log.clone(),
        })
    };
    let outer = client.remote_hooks().add(hook("outer", false));
    let inner = client.remote_hooks().add(hook("inner", false));
    assert_eq!(client.remote_hooks().len(), 2);

    let send = |text: &str| {
        let before = server.state_vector();
        type_text(server.doc(), "box:a", text);
        let u = server.doc().transact().encode_state_as_update_v1(&before);
        client.handle(&SyncDoc::update_message(u.clone())).unwrap();
        u
    };
    let u = send("Hi");
    // Inner first to finish; both saw the change happen inside their call.
    assert_eq!(
        *log.lock().unwrap(),
        [r#"inner: "" true "Hi""#, r#"outer: "" true "Hi""#]
    );
    // The same update again (an echo) changes nothing: the hooks still run, told so.
    log.lock().unwrap().clear();
    client.handle(&SyncDoc::update_message(u)).unwrap();
    assert_eq!(
        *log.lock().unwrap(),
        [r#"inner: "Hi" false "Hi""#, r#"outer: "Hi" false "Hi""#]
    );
    // A hook that doesn't call `apply`: applied after it anyway, exactly once.
    assert!(client.remote_hooks().remove(outer));
    assert!(client.remote_hooks().remove(inner));
    assert!(!client.remote_hooks().remove(inner));
    client.remote_hooks().add(hook("lazy", true));
    log.lock().unwrap().clear();
    send("!");
    assert_eq!(*log.lock().unwrap(), [r#"lazy: "Hi" false "Hi""#]);
    assert_eq!(read_text(client.doc(), "box:a"), "Hi!");
    // A local edit doesn't run them.
    log.lock().unwrap().clear();
    type_text(client.doc(), "box:a", "?");
    assert!(log.lock().unwrap().is_empty());
}

#[derive(Default)]
struct Events {
    statuses: Mutex<Vec<(Instant, Status)>>,
    changes: Mutex<u32>,
}
impl Listener for Events {
    fn on_status(&self, s: Status) {
        self.statuses.lock().unwrap().push((Instant::now(), s));
    }
    fn on_doc_changed(&self) {
        *self.changes.lock().unwrap() += 1;
    }
}
impl Events {
    fn all(&self) -> Vec<Status> {
        self.statuses
            .lock()
            .unwrap()
            .iter()
            .map(|(_, s)| s.clone())
            .collect()
    }
    fn count(&self, f: impl Fn(&Status) -> bool) -> usize {
        self.all().iter().filter(|s| f(s)).count()
    }
    fn syncs(&self) -> usize {
        self.count(|s| *s == Status::Synced)
    }
    fn last(&self) -> Option<Status> {
        self.all().last().cloned()
    }
    /// The Reconnecting statuses: (attempt, in_ms, code).
    fn reconnects(&self) -> Vec<(u32, u64, Option<u16>)> {
        self.all()
            .into_iter()
            .filter_map(|s| match s {
                Status::Reconnecting {
                    attempt,
                    in_ms,
                    code,
                    ..
                } => Some((attempt, in_ms, code)),
                _ => None,
            })
            .collect()
    }
}

/// Tokens from a list: `token()` gives the current one, `refresh` moves to the next (or signs out).
struct Tokens {
    list: Vec<&'static str>,
    at: AtomicUsize,
    refreshes: Mutex<Vec<String>>,
}
impl Tokens {
    fn new(list: &[&'static str]) -> Arc<Tokens> {
        Arc::new(Tokens {
            list: list.to_vec(),
            at: AtomicUsize::new(0),
            refreshes: Mutex::default(),
        })
    }
}
impl Session for Tokens {
    fn token(&self) -> Result<String, AuthError> {
        Ok(self.list[self.at.load(Ordering::SeqCst).min(self.list.len() - 1)].into())
    }
    fn refresh(&self, rejected: &str) -> Result<String, AuthError> {
        self.refreshes.lock().unwrap().push(rejected.into());
        let next = self.at.fetch_add(1, Ordering::SeqCst) + 1;
        self.list
            .get(next)
            .map(|t| t.to_string())
            .ok_or(AuthError::SignedOut)
    }
}

/// An outbox in memory, standing in for the store: it outlives the LiveDocs.
#[derive(Default)]
struct MemOutbox {
    kept: Mutex<BTreeMap<i64, Vec<u8>>>,
    next: AtomicUsize,
}
impl Outbox for MemOutbox {
    fn keep(&self, updates: &[Vec<u8>]) -> Vec<Option<i64>> {
        let mut kept = self.kept.lock().unwrap();
        updates
            .iter()
            .map(|u| {
                let k = self.next.fetch_add(1, Ordering::SeqCst) as i64 + 1;
                kept.insert(k, u.clone());
                Some(k)
            })
            .collect()
    }
    fn confirmed(&self, keys: &[i64]) {
        let mut kept = self.kept.lock().unwrap();
        for k in keys {
            kept.remove(k);
        }
    }
}
impl MemOutbox {
    fn len(&self) -> usize {
        self.kept.lock().unwrap().len()
    }
    fn entries(&self) -> Vec<(i64, Vec<u8>)> {
        self.kept
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (*k, v.clone()))
            .collect()
    }
}

fn fast(base_ms: u64, max_ms: u64) -> Options {
    Options {
        backoff: Backoff {
            base: Duration::from_millis(base_ms),
            max: Duration::from_millis(max_ms),
            jitter: true,
        },
        ..Options::default()
    }
}

fn start(server: &TestServer, session: Arc<dyn Session>, ev: &Arc<Events>, o: Options) -> LiveDoc {
    LiveDoc::start(&server.url, Doc::new(), session, ev.clone(), o).unwrap()
}

#[test]
fn live_docs_edit_together_through_the_server() {
    let server = TestServer::start(&["good"]);
    let (ea, eb) = (Arc::new(Events::default()), Arc::new(Events::default()));
    let mut a = LiveDoc::connect(&server.url, "good", Doc::new(), ea.clone()).unwrap();
    let b = LiveDoc::connect(&server.url, "good", Doc::new(), eb.clone()).unwrap();
    for e in [&ea, &eb] {
        wait_for("sync", || e.syncs() == 1);
    }
    assert_eq!(read_text(a.doc(), "box:main"), "Hello");

    // A types; B sees it.
    {
        let mut txn = a.doc().transact_mut();
        let frag = txn.get_or_insert_xml_fragment("box:main");
        let t = frag.get(&txn, 0).unwrap().into_xml_text().unwrap();
        t.insert(&mut txn, 5, ", world");
    }
    wait_for("B to see A's edit", || {
        read_text(b.doc(), "box:main") == "Hello, world"
    });
    assert!(*eb.changes.lock().unwrap() >= 2);
    // A's edit is confirmed (the receipt came back) and the receipt changed nothing.
    wait_for("A's receipt", || a.unconfirmed() == 0);
    let changes = *ea.changes.lock().unwrap();

    // An update made elsewhere (e.g. by the editor) goes out too.
    let other = Doc::new();
    type_text(&other, "box:new", "pasted");
    let u = other
        .transact()
        .encode_state_as_update_v1(&Default::default());
    b.apply_local_update(&u).unwrap();
    wait_for("A to see B's update", || {
        read_text(a.doc(), "box:new") == "pasted"
    });
    assert_eq!(
        *ea.changes.lock().unwrap(),
        changes + 1,
        "one change, one report"
    );

    a.close();
    assert_eq!(
        ea.last(),
        Some(Status::Closed {
            code: 1000,
            reason: "closed".into()
        })
    );
}

#[test]
fn reconnects_after_the_server_drops_the_connection() {
    let server = TestServer::start(&["good"]);
    let ev = Arc::new(Events::default());
    let live = start(&server, Tokens::new(&["good"]), &ev, fast(20, 200));
    wait_for("sync", || ev.syncs() == 1);
    assert_eq!(ev.all()[0], Status::Connecting { attempt: 0 });

    // The TCP connection just goes (no close frame).
    server.kick(None);
    wait_for("a second sync", || ev.syncs() == 2);
    assert_eq!(ev.reconnects()[0].0, 1);
    assert_eq!(ev.reconnects()[0].2, None, "no close code");

    // The server restarts (1012): back again, and edits still flow.
    server.kick(Some(1012));
    wait_for("a third sync", || ev.syncs() == 3);
    assert_eq!(ev.reconnects()[1].2, Some(1012));
    type_text(live.doc(), "box:after", "still live");
    wait_for("the server to see the edit", || {
        server.text("box:after") == "still live"
    });
    assert_eq!(server.connections(), 3);
}

#[test]
fn backs_off_doubling_to_the_cap_and_starts_again_after_a_sync() {
    let server = TestServer::start(&["good"]);
    server.set_offline(true);
    let ev = Arc::new(Events::default());
    let _live = start(&server, Tokens::new(&["good"]), &ev, fast(40, 160));
    wait_for("five retries", || ev.reconnects().len() >= 5);
    let r = ev.reconnects();
    for (i, nominal) in [40u64, 80, 160, 160, 160].into_iter().enumerate() {
        let (attempt, in_ms, _) = r[i];
        assert_eq!(attempt, i as u32 + 1);
        assert!(
            (nominal * 3 / 4..=nominal * 5 / 4).contains(&in_ms),
            "retry {attempt}: {in_ms} ms, nominal {nominal}"
        );
    }
    // The waits are real: each Connecting comes after the announced delay.
    {
        let st = ev.statuses.lock().unwrap();
        let mut announced: Option<(Instant, u64)> = None;
        for (t, s) in st.iter() {
            match s {
                Status::Reconnecting { in_ms, .. } => announced = Some((*t, *in_ms)),
                Status::Connecting { .. } => {
                    if let Some((at, ms)) = announced.take() {
                        assert!(t.duration_since(at) >= Duration::from_millis(ms));
                    }
                }
                _ => {}
            }
        }
    }

    server.set_offline(false);
    wait_for("sync", || ev.syncs() == 1);
    let before = ev.reconnects().len();
    server.kick(None);
    wait_for("the next retry", || ev.reconnects().len() > before);
    let (attempt, in_ms, _) = ev.reconnects()[before];
    assert_eq!(attempt, 1, "counting starts again after a sync");
    assert!((30..=50).contains(&in_ms), "{in_ms}");
}

#[test]
fn a_4401_refreshes_the_token_and_reconnects_at_once() {
    let server = TestServer::start(&["new"]);
    let ev = Arc::new(Events::default());
    let tokens = Tokens::new(&["old", "new"]);
    // A long base delay: only an immediate reconnect can sync in time.
    let _live = start(&server, tokens.clone(), &ev, fast(60_000, 60_000));
    wait_for("sync", || ev.syncs() == 1);
    assert_eq!(*tokens.refreshes.lock().unwrap(), ["old"]);
    assert_eq!(ev.reconnects(), [(1, 0, Some(4401))]);
}

#[test]
fn a_4401_when_signed_out_ends_the_connection() {
    let server = TestServer::start(&[]);
    let ev = Arc::new(Events::default());
    let _live = start(&server, Tokens::new(&["old"]), &ev, fast(20, 100));
    wait_for("the end", || {
        matches!(ev.last(), Some(Status::Closed { .. }))
    });
    assert_eq!(
        ev.last(),
        Some(Status::Closed {
            code: 4401,
            reason: "signed out".into()
        })
    );
    let n = server.connections();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(server.connections(), n, "no more tries");
}

#[test]
fn a_refresh_that_keeps_failing_backs_off_instead_of_spinning() {
    let server = TestServer::start(&[]);
    let ev = Arc::new(Events::default());
    let tokens = Tokens::new(&["a", "b", "c", "d", "e", "f", "g", "h"]);
    let _live = start(&server, tokens, &ev, fast(50, 50));
    wait_for("five retries", || ev.reconnects().len() >= 5);
    let r = ev.reconnects();
    assert!(
        r[..3]
            .iter()
            .all(|(_, ms, code)| *ms == 0 && *code == Some(4401)),
        "{r:?}"
    );
    assert!(r[3].1 > 0 && r[4].1 > 0, "then with delays: {r:?}");
}

#[test]
fn a_4403_stops_for_good() {
    let server = TestServer::start(&["good"]);
    server.set_forbidden(true);
    let ev = Arc::new(Events::default());
    let mut live = start(&server, Tokens::new(&["good"]), &ev, fast(20, 100));
    wait_for("the end", || {
        matches!(ev.last(), Some(Status::Closed { .. }))
    });
    assert!(matches!(ev.last(), Some(Status::Closed { code: 4403, .. })));
    assert!(ev.reconnects().is_empty());
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(server.connections(), 1);
    live.close();
    assert!(
        matches!(ev.last(), Some(Status::Closed { code: 4403, .. })),
        "closing after the end says nothing more"
    );
}

#[test]
fn close_returns_promptly_while_waiting_to_reconnect() {
    let server = TestServer::start(&["good"]);
    server.set_offline(true);
    let ev = Arc::new(Events::default());
    let mut live = start(&server, Tokens::new(&["good"]), &ev, fast(30_000, 30_000));
    wait_for("the wait", || !ev.reconnects().is_empty());
    let t = Instant::now();
    live.close();
    assert!(
        t.elapsed() < Duration::from_millis(500),
        "{:?}",
        t.elapsed()
    );
    assert_eq!(
        ev.last(),
        Some(Status::Closed {
            code: 1000,
            reason: "closed".into()
        })
    );
}

#[test]
fn close_returns_promptly_while_connecting() {
    // Accepts TCP (the OS does) but never answers the upgrade.
    let silent = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("ws://{}/collab/page-1", silent.local_addr().unwrap());
    let ev = Arc::new(Events::default());
    let mut live = LiveDoc::start(
        &url,
        Doc::new(),
        Tokens::new(&["t"]),
        ev.clone(),
        fast(20, 20),
    )
    .unwrap();
    wait_for("connecting", || {
        ev.count(|s| matches!(s, Status::Connecting { .. })) > 0
    });
    let t = Instant::now();
    live.close();
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    assert!(matches!(ev.last(), Some(Status::Closed { code: 1000, .. })));
}

#[test]
fn edits_made_offline_are_sent_after_reconnecting() {
    let server = TestServer::start(&["good"]);
    let ev = Arc::new(Events::default());
    let outbox = Arc::new(MemOutbox::default());
    let live = start(
        &server,
        Tokens::new(&["good"]),
        &ev,
        Options {
            outbox: Some(outbox.clone()),
            ..fast(30, 60)
        },
    );
    wait_for("sync", || ev.syncs() == 1);
    server.set_offline(true);
    server.kick(None);
    wait_for("offline", || !ev.reconnects().is_empty());

    type_text(live.doc(), "box:offline", "typed on the train");
    wait_for("the edit to be kept", || outbox.len() == 1);
    assert_eq!(live.unconfirmed(), 1);
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(server.text("box:offline"), "");

    server.set_offline(false);
    wait_for("the server to get it", || {
        server.text("box:offline") == "typed on the train"
    });
    wait_for("the receipt", || {
        outbox.len() == 0 && live.unconfirmed() == 0
    });
}

#[test]
fn queued_edits_survive_into_a_new_live_doc() {
    let server = TestServer::start(&["good"]);
    server.set_offline(true);
    let outbox = Arc::new(MemOutbox::default());
    let options = || Options {
        outbox: Some(outbox.clone()),
        ..fast(30, 60)
    };
    {
        let ev = Arc::new(Events::default());
        let mut live = start(&server, Tokens::new(&["good"]), &ev, options());
        wait_for("offline", || !ev.reconnects().is_empty());
        type_text(live.doc(), "box:new", "before the restart");
        type_text(live.doc(), "box:new", "!");
        live.close();
    }
    assert_eq!(outbox.len(), 2, "kept, not sent");

    // The app starts again: a fresh document, the queued edits restored into it.
    server.set_offline(false);
    let ev = Arc::new(Events::default());
    let live = start(
        &server,
        Tokens::new(&["good"]),
        &ev,
        Options {
            restored: outbox.entries(),
            ..options()
        },
    );
    assert_eq!(read_text(live.doc(), "box:new"), "before the restart!");
    assert_eq!(live.unconfirmed(), 2);
    wait_for("the server to get them", || {
        server.text("box:new") == "before the restart!"
    });
    wait_for("the receipt", || {
        outbox.len() == 0 && live.unconfirmed() == 0
    });
    assert_eq!(read_text(live.doc(), "box:main"), "Hello");
}

#[test]
fn a_bad_token_is_closed_with_4401() {
    let server = TestServer::start(&["good"]);
    let e = Arc::new(Events::default());
    let _live = LiveDoc::connect(&server.url, "expired", Doc::new(), e.clone()).unwrap();
    wait_for("the close", || {
        matches!(e.last(), Some(Status::Closed { .. }))
    });
    assert!(
        e.all()
            .iter()
            .any(|s| matches!(s, Status::Closed { code: 4401, .. })),
        "{:?}",
        e.all()
    );
}

#[test]
fn connect_errors_are_reported() {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let e = Arc::new(Events::default());
    assert!(LiveDoc::connect(
        &format!("ws://127.0.0.1:{port}/collab/x"),
        "t",
        Doc::new(),
        e.clone()
    )
    .is_err());
    assert!(LiveDoc::connect("not a url", "t", Doc::new(), e.clone()).is_err());
    assert!(LiveDoc::start(
        "not a url",
        Doc::new(),
        Tokens::new(&["t"]),
        e,
        Options::default()
    )
    .is_err());
}

#[test]
fn backoff_delays() {
    let b = Backoff {
        jitter: false,
        ..Backoff::default()
    };
    let secs: Vec<u64> = (0..8).map(|n| b.delay(n).as_secs()).collect();
    assert_eq!(secs, [1, 2, 4, 8, 16, 30, 30, 30]);
    assert_eq!(b.delay(100), Duration::from_secs(30));
    let j = Backoff::default();
    for n in 0..50 {
        let d = j.delay(n % 7).as_secs_f64() / b.delay(n % 7).as_secs_f64();
        assert!((0.75..1.25).contains(&d), "{d}");
    }
}
