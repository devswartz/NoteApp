//! A live page: one collab socket to the server, run on its own thread.
//!
//! The socket authenticates like the web app (subprotocols `noteapp.v1` and `bearer.<token>`;
//! the server never echoes the token). Local edits (any transaction on the doc without the
//! remote origin) are sent as updates; remote ones are applied and reported to the listener.
//! The server closes with 4401 when the token lapses (refresh, then reopen) and 4403 when
//! access is gone. Reconnecting is the caller's job for now.

use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::{Message as WsMessage, WebSocket};
use yrs::{Doc, Origin};

use crate::protocol::{SyncDoc, REMOTE_ORIGIN};

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// Socket open, waiting for the server's copy.
    Connected,
    /// The document has everything the server had; edits flow both ways.
    Synced,
    /// The socket closed. `code` is the WebSocket close code (4401: token expired, 4403: no access).
    Closed { code: u16, reason: String },
    /// The connection failed (network, protocol).
    Failed(String),
}

/// Told about changes, on the connection's thread. Keep it quick: copy what you need and return.
pub trait Listener: Send + Sync {
    fn on_status(&self, status: Status);
    /// The document changed by someone else's edit (or the initial sync).
    fn on_doc_changed(&self);
    fn on_presence_changed(&self) {}
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConnectError {
    Url(String),
    Network(String),
    /// The server refused the socket (HTTP status of the upgrade response).
    Refused(u16),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Url(e) => write!(f, "bad collab URL: {e}"),
            ConnectError::Network(e) => write!(f, "could not connect: {e}"),
            ConnectError::Refused(s) => write!(f, "the server refused the connection ({s})"),
        }
    }
}
impl std::error::Error for ConnectError {}

/// TCP, or TLS over TCP.
pub enum Stream {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Stream::Plain(s) => s.read(buf),
            Stream::Tls(s) => s.read(buf),
        }
    }
}
impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Stream::Plain(s) => s.write(buf),
            Stream::Tls(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Stream::Plain(s) => s.flush(),
            Stream::Tls(s) => s.flush(),
        }
    }
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let roots = rustls::RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
            Arc::new(cfg)
        })
        .clone()
}

/// How often the thread wakes to send local edits when nothing arrives.
const POLL: Duration = Duration::from_millis(50);

/// Open a WebSocket to `url` (ws:// or wss://) with the server's subprotocols.
pub fn open_socket(url: &str, token: &str) -> Result<WebSocket<Stream>, ConnectError> {
    let mut req = url
        .into_client_request()
        .map_err(|e| ConnectError::Url(e.to_string()))?;
    let protocols = HeaderValue::from_str(&format!("noteapp.v1, bearer.{token}"))
        .map_err(|e| ConnectError::Url(e.to_string()))?;
    req.headers_mut()
        .insert("Sec-WebSocket-Protocol", protocols);
    let uri = req.uri().clone();
    let host = uri
        .host()
        .ok_or_else(|| ConnectError::Url("no host".into()))?
        .to_string();
    let tls = uri.scheme_str() == Some("wss");
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let addr = (host.trim_matches(['[', ']']), port)
        .to_socket_addrs()
        .map_err(|e| ConnectError::Network(e.to_string()))?
        .next()
        .ok_or_else(|| ConnectError::Network(format!("{host} has no address")))?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10))
        .map_err(|e| ConnectError::Network(e.to_string()))?;
    tcp.set_nodelay(true).ok();
    let stream = if tls {
        let name =
            rustls::pki_types::ServerName::try_from(host.trim_matches(['[', ']']).to_string())
                .map_err(|e| ConnectError::Url(e.to_string()))?;
        let conn = rustls::ClientConnection::new(tls_config(), name)
            .map_err(|e| ConnectError::Network(e.to_string()))?;
        Stream::Tls(Box::new(rustls::StreamOwned::new(conn, tcp)))
    } else {
        Stream::Plain(tcp)
    };
    let (socket, _) = tungstenite::client::client(req, stream).map_err(|e| match e {
        tungstenite::HandshakeError::Failure(tungstenite::Error::Http(res)) => {
            ConnectError::Refused(res.status().as_u16())
        }
        e => ConnectError::Network(e.to_string()),
    })?;
    Ok(socket)
}

fn set_read_timeout(s: &WebSocket<Stream>, t: Option<Duration>) {
    let tcp = match s.get_ref() {
        Stream::Plain(t) => t,
        Stream::Tls(t) => t.get_ref(),
    };
    tcp.set_read_timeout(t).ok();
}

fn would_block(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut))
}

/// A page kept in sync with the server until closed (or dropped).
pub struct LiveDoc {
    sync: SyncDoc,
    outgoing: Sender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    /// Key of the doc observer that queues local edits (removed on close).
    observer: Origin,
}

impl LiveDoc {
    /// Connect `doc` to the page at `url` (from `nv_api::Client::collab_url`) with an access token.
    pub fn connect(
        url: &str,
        token: &str,
        doc: Doc,
        listener: Arc<dyn Listener>,
    ) -> Result<LiveDoc, ConnectError> {
        let socket = open_socket(url, token)?;
        let sync = SyncDoc::new(doc);
        let (tx, rx) = channel::<Vec<u8>>();
        // Every local transaction becomes an update message.
        let local_tx = tx.clone();
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let observer =
            Origin::from(format!("nv-sync:live:{}", NEXT.fetch_add(1, Ordering::Relaxed)).as_str());
        sync.doc()
            .observe_update_v1(observer.clone(), move |txn, e| {
                if txn.origin().map(|o| o.as_ref()) != Some(REMOTE_ORIGIN.as_bytes()) {
                    let _ = local_tx.send(SyncDoc::update_message(e.update.clone()));
                }
            })
            .map_err(|e| ConnectError::Network(format!("the document is busy: {e}")))?;
        for m in sync.hello() {
            tx.send(m).ok();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (sync, stop) = (sync.clone(), stop.clone());
            std::thread::Builder::new()
                .name("nv-sync".into())
                .spawn(move || run(socket, sync, rx, stop, listener))
                .map_err(|e| ConnectError::Network(e.to_string()))?
        };
        Ok(LiveDoc {
            sync,
            outgoing: tx,
            stop,
            thread: Some(thread),
            observer,
        })
    }

    pub fn doc(&self) -> &Doc {
        self.sync.doc()
    }

    /// Apply a local edit made elsewhere (a Yjs update); it is sent to the server.
    pub fn apply_local_update(&self, update: &[u8]) -> Result<(), crate::SyncError> {
        use yrs::updates::decoder::Decode;
        use yrs::Transact;
        let u = yrs::Update::decode_v1(update)
            .map_err(|e| crate::SyncError::Protocol(e.to_string()))?;
        self.sync
            .doc()
            .transact_mut()
            .apply_update(u)
            .map_err(|e| crate::SyncError::Protocol(e.to_string()))
    }

    /// Set this client's presence (JSON) and announce it.
    pub fn set_presence(&self, json: &str) {
        let _ = self.outgoing.send(self.sync.set_presence(json));
    }

    pub fn presence(&self) -> Vec<(u64, String)> {
        self.sync.presence()
    }

    /// Close the socket and wait for the thread to finish.
    pub fn close(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
            let _ = self.sync.doc().unobserve_update_v1(self.observer.clone());
        }
    }
}

impl Drop for LiveDoc {
    fn drop(&mut self) {
        self.close();
    }
}

fn run(
    mut socket: WebSocket<Stream>,
    sync: SyncDoc,
    rx: Receiver<Vec<u8>>,
    stop: Arc<AtomicBool>,
    listener: Arc<dyn Listener>,
) {
    listener.on_status(Status::Connected);
    set_read_timeout(&socket, Some(POLL));
    let fail = |l: &Arc<dyn Listener>, e: String| l.on_status(Status::Failed(e));
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = socket.close(None);
            let _ = socket.flush();
            listener.on_status(Status::Closed {
                code: 1000,
                reason: "closed".into(),
            });
            return;
        }
        // Send what's queued.
        while let Ok(m) = rx.try_recv() {
            if let Err(e) = socket.write(WsMessage::Binary(m.into())) {
                if !would_block(&e) {
                    return fail(&listener, e.to_string());
                }
            }
        }
        if let Err(e) = socket.flush() {
            if !would_block(&e) {
                return fail(&listener, e.to_string());
            }
        }
        match socket.read() {
            Ok(WsMessage::Binary(data)) => match sync.handle(&data) {
                Ok(h) => {
                    for r in h.replies {
                        let _ = socket.write(WsMessage::Binary(r.into()));
                    }
                    if h.doc_changed {
                        listener.on_doc_changed();
                    }
                    if h.synced {
                        listener.on_status(Status::Synced);
                    }
                    if h.awareness_changed {
                        listener.on_presence_changed();
                    }
                }
                Err(e) => return fail(&listener, e.to_string()),
            },
            Ok(WsMessage::Close(frame)) => {
                let (code, reason) = frame
                    .map(|f| (u16::from(f.code), f.reason.to_string()))
                    .unwrap_or((u16::from(CloseCode::Status), String::new()));
                let _ = socket.flush();
                return listener.on_status(Status::Closed { code, reason });
            }
            Ok(_) => {}
            Err(e) if would_block(&e) => {}
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return listener.on_status(Status::Closed {
                    code: u16::from(CloseCode::Abnormal),
                    reason: String::new(),
                });
            }
            Err(e) => return fail(&listener, e.to_string()),
        }
    }
}
