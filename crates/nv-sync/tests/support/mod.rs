//! A stand-in for today's collab server (server/collab.ts), in process, for nv-sync's and
//! nv-core's tests: the auth subprotocol, step 1 on connect, updates relayed to the room, 4401
//! for a token it doesn't accept, 4403 when access is gone. Tests can drop every connection,
//! close them with a code, or make the server unreachable.
//!
//! Used by crates/nv-sync/tests/sync.rs and (through `#[path]`) crates/nv-core/tests/live.rs.

// tungstenite's handshake callback type is fixed by its API.
#![allow(clippy::result_large_err, dead_code)]

use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nv_sync::yrs::{
    Doc, GetString, Origin, ReadTxn, Transact, WriteTxn, XmlFragment, XmlTextPrelim,
};
use nv_sync::SyncDoc;
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::http::HeaderValue;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::protocol::CloseFrame;
use tungstenite::Message;

pub fn type_text(doc: &Doc, field: &str, text: &str) {
    let mut txn = doc.transact_mut();
    let frag = txn.get_or_insert_xml_fragment(field);
    frag.push_back(&mut txn, XmlTextPrelim::new(text));
}

pub fn read_text(doc: &Doc, field: &str) -> String {
    let txn = doc.transact();
    txn.get_xml_fragment(field)
        .map(|f| f.get_string(&txn))
        .unwrap_or_default()
}

pub fn wait_for(what: &str, f: impl Fn() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

enum Ctl {
    Send(Vec<u8>),
    Close(u16),
    Drop,
}

#[derive(Default)]
struct State {
    tokens: Mutex<Vec<String>>,
    offline: AtomicBool,
    forbidden: AtomicBool,
    /// WebSocket handshakes completed.
    accepted: AtomicUsize,
    conns: Mutex<Vec<Sender<Ctl>>>,
}

/// One room (whatever the page id), as server/collab.ts keeps one per page.
pub struct TestServer {
    /// `ws://127.0.0.1:<port>/collab/page-1`
    pub url: String,
    /// `http://127.0.0.1:<port>`, for a Core.
    pub base: String,
    pub room: SyncDoc,
    state: Arc<State>,
}

impl TestServer {
    /// A server accepting these tokens, whose room has "Hello" in `box:main`.
    pub fn start(tokens: &[&str]) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let room = SyncDoc::new(Doc::new());
        type_text(room.doc(), "box:main", "Hello");
        let state = Arc::new(State::default());
        *state.tokens.lock().unwrap() = tokens.iter().map(|t| t.to_string()).collect();
        {
            let state = state.clone();
            room.doc()
                .observe_update_v1(Origin::from("relay"), move |_, e| {
                    let m = SyncDoc::update_message(e.update.clone());
                    state
                        .conns
                        .lock()
                        .unwrap()
                        .retain(|c| c.send(Ctl::Send(m.clone())).is_ok());
                })
                .unwrap();
        }
        {
            let (room, state) = (room.clone(), state.clone());
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else { continue };
                    if state.offline.load(Ordering::SeqCst) {
                        drop(stream);
                        continue;
                    }
                    let (room, state) = (room.clone(), state.clone());
                    std::thread::spawn(move || serve(stream, room, state));
                }
            });
        }
        TestServer {
            url: format!("ws://{addr}/collab/page-1"),
            base: format!("http://{addr}"),
            room,
            state,
        }
    }

    pub fn set_tokens(&self, tokens: &[&str]) {
        *self.state.tokens.lock().unwrap() = tokens.iter().map(|t| t.to_string()).collect();
    }

    /// Unreachable: new connections are dropped before the upgrade.
    pub fn set_offline(&self, offline: bool) {
        self.state.offline.store(offline, Ordering::SeqCst);
    }

    /// New connections are closed with 4403.
    pub fn set_forbidden(&self, forbidden: bool) {
        self.state.forbidden.store(forbidden, Ordering::SeqCst);
    }

    /// End every open connection: with a close frame (`code`), or by dropping the TCP stream.
    pub fn kick(&self, code: Option<u16>) {
        for c in self.state.conns.lock().unwrap().drain(..) {
            let _ = c.send(code.map_or(Ctl::Drop, Ctl::Close));
        }
    }

    /// WebSocket handshakes so far.
    pub fn connections(&self) -> usize {
        self.state.accepted.load(Ordering::SeqCst)
    }

    pub fn text(&self, field: &str) -> String {
        read_text(self.room.doc(), field)
    }
}

fn serve(stream: std::net::TcpStream, room: SyncDoc, state: Arc<State>) {
    let mut token = String::new();
    let cb = |req: &Request, mut res: Response| -> Result<Response, ErrorResponse> {
        let protos = req
            .headers()
            .get("Sec-WebSocket-Protocol")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        token = protos
            .split(',')
            .find_map(|p| p.trim().strip_prefix("bearer."))
            .unwrap_or("")
            .to_string();
        assert!(req.uri().path().contains("/collab/"));
        res.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_static("noteapp.v1"),
        );
        Ok(res)
    };
    let Ok(mut ws) = tungstenite::accept_hdr(stream, cb) else {
        return;
    };
    state.accepted.fetch_add(1, Ordering::SeqCst);
    let refuse = |ws: &mut tungstenite::WebSocket<std::net::TcpStream>, code: u16, why: &str| {
        let _ = ws.close(Some(CloseFrame {
            code: CloseCode::from(code),
            reason: why.to_string().into(),
        }));
        let _ = ws.flush();
        std::thread::sleep(Duration::from_millis(100));
    };
    if !state.tokens.lock().unwrap().contains(&token) {
        return refuse(&mut ws, 4401, "Unauthorized");
    }
    if state.forbidden.load(Ordering::SeqCst) {
        return refuse(&mut ws, 4403, "No access to this page");
    }
    let (tx, rx) = channel();
    state.conns.lock().unwrap().push(tx);
    ws.get_ref()
        .set_read_timeout(Some(Duration::from_millis(20)))
        .unwrap();
    for m in room.hello() {
        ws.send(Message::Binary(m.into())).unwrap();
    }
    loop {
        while let Ok(c) = rx.try_recv() {
            match c {
                Ctl::Send(m) => {
                    if ws.send(Message::Binary(m.into())).is_err() {
                        return;
                    }
                }
                Ctl::Close(code) => return refuse(&mut ws, code, "kicked"),
                Ctl::Drop => return,
            }
        }
        match ws.read() {
            Ok(Message::Binary(d)) => {
                for r in room.handle(&d).unwrap().replies {
                    let _ = ws.send(Message::Binary(r.into()));
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
}
