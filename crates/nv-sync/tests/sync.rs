//! nv-sync against a stand-in for today's server: the protocol in memory, then real sockets to an
//! in-process server that behaves like server/collab.ts (auth subprotocol, step 1 on connect,
//! updates relayed to the room, 4401 for a bad token).

// tungstenite's handshake callback type is fixed by its API.
#![allow(clippy::result_large_err)]

use std::net::TcpListener;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nv_sync::yrs::{
    Doc, GetString, Origin, ReadTxn, Text, Transact, WriteTxn, XmlFragment, XmlTextPrelim,
};
use nv_sync::{Listener, LiveDoc, Status, SyncDoc};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::HeaderValue;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::CloseFrame;
use tungstenite::Message;

fn type_text(doc: &Doc, field: &str, text: &str) {
    let mut txn = doc.transact_mut();
    let frag = txn.get_or_insert_xml_fragment(field);
    frag.push_back(&mut txn, XmlTextPrelim::new(text));
}

fn read_text(doc: &Doc, field: &str) -> String {
    let txn = doc.transact();

    txn.get_xml_fragment(field)
        .map(|f| f.get_string(&txn))
        .unwrap_or_default()
}

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

    // Presence.
    let m = client.set_presence(r#"{"user":{"name":"Ann"}}"#);
    assert!(server.handle(&m).unwrap().awareness_changed);
    assert!(server.presence().iter().any(|(_, s)| s.contains("Ann")));

    assert!(
        server.handle(&[200]).is_err(),
        "a truncated message is an error"
    );
}

/// A room like server/collab.ts's: one doc, every connection gets its updates.
struct TestServer {
    url: String,
}

fn start_server(token: &'static str) -> TestServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("ws://{}/collab/page-1", listener.local_addr().unwrap());
    let room = SyncDoc::new(Doc::new());
    type_text(room.doc(), "box:main", "Hello");
    let conns: Arc<Mutex<Vec<Sender<Vec<u8>>>>> = Arc::default();
    {
        let conns = conns.clone();
        room.doc()
            .observe_update_v1(Origin::from("relay"), move |_, e| {
                let m = SyncDoc::update_message(e.update.clone());
                conns.lock().unwrap().retain(|c| c.send(m.clone()).is_ok());
            })
            .unwrap();
    }
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let stream = stream.unwrap();
            let (room, conns) = (room.clone(), conns.clone());
            std::thread::spawn(move || {
                let mut authed = false;
                let cb = |req: &Request, mut res: Response| -> Result<Response, ErrorResponse> {
                    let protos = req
                        .headers()
                        .get("Sec-WebSocket-Protocol")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    authed = protos
                        .split(',')
                        .any(|p| p.trim() == format!("bearer.{token}"));
                    assert!(req.uri().path().ends_with("/collab/page-1"));
                    res.headers_mut().insert(
                        "Sec-WebSocket-Protocol",
                        HeaderValue::from_static("noteapp.v1"),
                    );
                    Ok(res)
                };
                let mut ws = tungstenite::accept_hdr(stream, cb).unwrap();
                if !authed {
                    let _ = ws.close(Some(CloseFrame {
                        code: CloseCode::from(4401),
                        reason: "Unauthorized".into(),
                    }));
                    let _ = ws.flush();
                    std::thread::sleep(Duration::from_millis(100));
                    return;
                }
                let (tx, rx) = channel();
                conns.lock().unwrap().push(tx);
                ws.get_ref()
                    .set_read_timeout(Some(Duration::from_millis(20)))
                    .unwrap();
                for m in room.hello() {
                    ws.send(Message::Binary(m.into())).unwrap();
                }
                loop {
                    while let Ok(m) = rx.try_recv() {
                        if ws.send(Message::Binary(m.into())).is_err() {
                            return;
                        }
                    }
                    match ws.read() {
                        Ok(Message::Binary(d)) => {
                            for r in room.handle(&d).unwrap().replies {
                                ws.send(Message::Binary(r.into())).unwrap();
                            }
                        }
                        Ok(Message::Close(_)) => return,
                        Ok(_) => {}
                        Err(tungstenite::Error::Io(e))
                            if matches!(
                                e.kind(),
                                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                            ) => {}
                        Err(_) => return,
                    }
                }
            });
        }
    });
    TestServer { url }
}

#[derive(Default)]
struct Events {
    statuses: Mutex<Vec<Status>>,
    changes: Mutex<u32>,
}
impl Listener for Events {
    fn on_status(&self, s: Status) {
        self.statuses.lock().unwrap().push(s);
    }
    fn on_doc_changed(&self) {
        *self.changes.lock().unwrap() += 1;
    }
}

fn wait_for(what: &str, f: impl Fn() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn live_docs_edit_together_through_the_server() {
    let server = start_server("good");
    let (ea, eb) = (Arc::new(Events::default()), Arc::new(Events::default()));
    let mut a = LiveDoc::connect(&server.url, "good", Doc::new(), ea.clone()).unwrap();
    let b = LiveDoc::connect(&server.url, "good", Doc::new(), eb.clone()).unwrap();
    for e in [&ea, &eb] {
        wait_for("sync", || {
            e.statuses.lock().unwrap().contains(&Status::Synced)
        });
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

    a.close();
    assert_eq!(
        ea.statuses.lock().unwrap().last(),
        Some(&Status::Closed {
            code: 1000,
            reason: "closed".into()
        })
    );
}

#[test]
fn a_bad_token_is_closed_with_4401() {
    let server = start_server("good");
    let e = Arc::new(Events::default());
    let _live = LiveDoc::connect(&server.url, "expired", Doc::new(), e.clone()).unwrap();
    wait_for("the close", || {
        e.statuses
            .lock()
            .unwrap()
            .iter()
            .any(|s| matches!(s, Status::Closed { .. }))
    });
    let st = e.statuses.lock().unwrap();
    assert!(
        st.iter()
            .any(|s| matches!(s, Status::Closed { code: 4401, .. })),
        "{st:?}"
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
    assert!(LiveDoc::connect("not a url", "t", Doc::new(), e).is_err());
}
