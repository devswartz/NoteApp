//! A live page: one collab socket to the server, run on its own thread, reconnecting until closed.
//!
//! The socket authenticates like the web app (subprotocols `noteapp.v1` and `bearer.<token>`;
//! the server never echoes the token). Local edits (any transaction on the doc without the
//! remote origin) are sent as updates; remote ones are applied and reported to the listener.
//!
//! **Reconnecting.** When the socket drops or can't be opened, the thread waits and tries again:
//! about 1 s doubling to 30 s, with jitter (`Backoff`, as `backoffMs` in src/api.ts), back to
//! 1 s after a successful sync. The server closes with 4401 when the access token lapses: the
//! thread asks the `Session` for a fresh token and reconnects at once (up to
//! `Options::auth_retries` times in a row, then with the usual delays); when the session is
//! signed out it stops with `Closed { code: 4401 }`. 4403 means access is gone: it stops with
//! `Closed { code: 4403 }`. `close()` stops it at once (it never waits out a delay).
//!
//! **Local edits are kept until the server has them.** Each one goes into a queue (and, with an
//! `Outbox`, on disk), is sent once the sync handshake is done (again after every reconnect:
//! Yjs updates are idempotent, so sending one twice is harmless), and is dropped from the queue
//! when a receipt comes back: after sending edits the thread sends a sync step 1, and the server
//! answers each step 1 with a step 2, in order, after applying everything sent before it on that
//! connection (server/collab.ts handles a connection's messages one by one). Edits queued in an
//! earlier run (`Options::restored`) are applied to the document first and sent the same way.
//! A viewer's edits are dropped by the server; their receipt still clears them.

use std::collections::VecDeque;
use std::hash::BuildHasher;
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::{Message as WsMessage, WebSocket};
use yrs::updates::decoder::Decode;
use yrs::{Doc, Origin, Transact};

use crate::protocol::{RemoteHooks, SyncDoc, REMOTE_ORIGIN};

#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// Opening the socket: `attempt` 0 the first time, then how many tries in a row have failed.
    Connecting { attempt: u32 },
    /// Socket open, waiting for the server's copy.
    Connected,
    /// The document has everything the server had; edits flow both ways.
    Synced,
    /// Not connected (the socket dropped, or couldn't be opened); trying again in `in_ms`
    /// milliseconds (0: at once, after a token refresh). `attempt` counts from 1 and goes back
    /// to 1 after a successful sync. `code` is the server's close code when it closed the socket.
    Reconnecting {
        attempt: u32,
        in_ms: u64,
        code: Option<u16>,
        reason: String,
    },
    /// Stopped for good, the last status: 1000 after `close()`, 4403 no access (from the
    /// server), 4401 signed out (the session couldn't be refreshed).
    Closed { code: u16, reason: String },
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

/// Why there is no token.
#[derive(Debug, Clone, PartialEq)]
pub enum AuthError {
    /// The session is gone (the refresh token was rejected): sign in again.
    SignedOut,
    /// No answer now (offline, server error): try again later.
    Unavailable(String),
}

/// Where the connection gets its access tokens (the Core's session). Called on the
/// connection's thread; may block on the network.
pub trait Session: Send + Sync {
    /// A valid access token (refreshed first if it is about to expire).
    fn token(&self) -> Result<String, AuthError>;
    /// The server refused `rejected` (closed with 4401): a new token. Implementations should
    /// return a newer token another caller already got instead of refreshing again.
    fn refresh(&self, rejected: &str) -> Result<String, AuthError>;
}

/// One token, never refreshed (`LiveDoc::connect`).
struct FixedToken(String);
impl Session for FixedToken {
    fn token(&self) -> Result<String, AuthError> {
        Ok(self.0.clone())
    }
    fn refresh(&self, _: &str) -> Result<String, AuthError> {
        Err(AuthError::SignedOut)
    }
}

/// Keeps local edits on disk until the server has them (the Core's store). Called on the
/// connection's thread, and by `close()`.
pub trait Outbox: Send + Sync {
    /// Keep these updates; a key for each, None for one that isn't kept (memory only).
    fn keep(&self, updates: &[Vec<u8>]) -> Vec<Option<i64>>;
    /// The server has these: forget them.
    fn confirmed(&self, keys: &[i64]);
}

/// Delays between reconnects: `base` doubling up to `max`, each times 0.75–1.25 with `jitter`.
#[derive(Debug, Clone, PartialEq)]
pub struct Backoff {
    pub base: Duration,
    pub max: Duration,
    pub jitter: bool,
}

impl Default for Backoff {
    fn default() -> Self {
        Backoff {
            base: Duration::from_secs(1),
            max: Duration::from_secs(30),
            jitter: true,
        }
    }
}

impl Backoff {
    /// The wait before retry `failures + 1` (`failures` tries in a row have failed).
    pub fn delay(&self, failures: u32) -> Duration {
        let d = self
            .base
            .saturating_mul(1u32 << failures.min(20))
            .min(self.max);
        if self.jitter {
            d.mul_f64(0.75 + random_unit() / 2.0)
        } else {
            d
        }
    }
}

/// A number in [0, 1), from the standard library's randomly keyed hasher.
fn random_unit() -> f64 {
    let h = std::collections::hash_map::RandomState::new().hash_one(Instant::now());
    (h >> 11) as f64 / (1u64 << 53) as f64
}

pub struct Options {
    pub backoff: Backoff,
    /// Where local edits are kept until the server has them; None: memory only.
    pub outbox: Option<Arc<dyn Outbox>>,
    /// Edits queued in an earlier run (key, Yjs update), oldest first: applied to the document
    /// before connecting and sent after the handshake.
    pub restored: Vec<(i64, Vec<u8>)>,
    /// How many 4401s in a row are answered by a refresh and an immediate reconnect.
    pub auth_retries: u32,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            backoff: Backoff::default(),
            outbox: None,
            restored: Vec::new(),
            auth_retries: 3,
        }
    }
}

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

/// TLS with the system's trust store and verifier (rustls-platform-verifier): Security.framework
/// on Apple platforms, the Windows certificate store, the system roots on Linux. On Android it
/// needs initialising from Java first (not done yet; see docs/rewrite/status/core.md).
fn tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
    static CONFIG: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            use rustls_platform_verifier::BuilderVerifierExt;
            let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_platform_verifier()
            .map_err(|e| format!("no certificate verifier: {e}"))?
            .with_no_client_auth();
            Ok(Arc::new(cfg))
        })
        .clone()
}

/// How often the thread wakes to send local edits when nothing arrives.
const POLL: Duration = Duration::from_millis(50);
/// Time allowed for TCP connect, TLS and the WebSocket upgrade, each.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// At most one receipt (step 1) every this often while edits are being sent.
const RECEIPT_EVERY: Duration = Duration::from_millis(500);
/// How long `close()` waits for the thread (e.g. stuck in a connect) before leaving it to finish alone.
const CLOSE_WAIT: Duration = Duration::from_secs(1);

/// Open a WebSocket to `url` (ws:// or wss://) with the server's subprotocols. Blocks.
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
    let tcp = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| ConnectError::Network(e.to_string()))?;
    tcp.set_nodelay(true).ok();
    tcp.set_read_timeout(Some(CONNECT_TIMEOUT)).ok();
    tcp.set_write_timeout(Some(CONNECT_TIMEOUT)).ok();
    let stream = if tls {
        let name =
            rustls::pki_types::ServerName::try_from(host.trim_matches(['[', ']']).to_string())
                .map_err(|e| ConnectError::Url(e.to_string()))?;
        let conn =
            rustls::ClientConnection::new(tls_config().map_err(ConnectError::Network)?, name)
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

/// What the caller and the connection's thread share.
struct Shared {
    inner: Mutex<Inner>,
    wake: Condvar,
    listener: Arc<dyn Listener>,
}

#[derive(Default)]
struct Inner {
    /// `close()` was called.
    stop: bool,
    /// The thread has finished.
    exited: bool,
    /// The last status (`Closed`) has been reported: nothing more is.
    ended: bool,
    /// Local updates the thread hasn't taken into its queue yet.
    fresh: Vec<Vec<u8>>,
    /// Messages to send if connected (presence).
    control: Vec<Vec<u8>>,
    /// Updates in the thread's queue (not yet confirmed).
    queued: usize,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn stopped(&self) -> bool {
        self.lock().stop
    }

    /// Tell the listener, unless the last status has been reported already.
    fn report(&self, status: Status) {
        {
            let mut i = self.lock();
            if i.ended {
                return;
            }
            if matches!(status, Status::Closed { .. }) {
                i.ended = true;
            }
        }
        self.listener.on_status(status);
    }

    fn ended(&self) -> bool {
        self.lock().ended
    }
}

/// A page kept in sync with the server until closed (or dropped).
pub struct LiveDoc {
    sync: SyncDoc,
    shared: Arc<Shared>,
    outbox: Option<Arc<dyn Outbox>>,
    thread: Option<JoinHandle<()>>,
    /// Key of the doc observer that queues local edits (removed on close).
    observer: Origin,
}

impl LiveDoc {
    /// Connect `doc` to the page at `url` (from `nv_api::Client::collab_url`) with an access
    /// token, blocking until the socket is open. It reconnects after drops with default options;
    /// the token is never refreshed (a 4401 ends it with `Closed { code: 4401 }`).
    pub fn connect(
        url: &str,
        token: &str,
        doc: Doc,
        listener: Arc<dyn Listener>,
    ) -> Result<LiveDoc, ConnectError> {
        let socket = open_socket(url, token)?;
        Self::spawn(
            url,
            doc,
            Arc::new(FixedToken(token.into())),
            listener,
            Options::default(),
            Some((socket, token.into())),
        )
    }

    /// Keep `doc` in sync with the page at `url`, connecting on the new thread: returns at once
    /// (an error only for a URL that can't be used). Tokens come from `session`.
    pub fn start(
        url: &str,
        doc: Doc,
        session: Arc<dyn Session>,
        listener: Arc<dyn Listener>,
        options: Options,
    ) -> Result<LiveDoc, ConnectError> {
        url.into_client_request()
            .map_err(|e| ConnectError::Url(e.to_string()))?;
        Self::spawn(url, doc, session, listener, options, None)
    }

    /// As `start`, over a socket already opened (with `open_socket`) with `token`.
    pub fn start_connected(
        socket: WebSocket<Stream>,
        token: String,
        url: &str,
        doc: Doc,
        session: Arc<dyn Session>,
        listener: Arc<dyn Listener>,
        options: Options,
    ) -> Result<LiveDoc, ConnectError> {
        Self::spawn(url, doc, session, listener, options, Some((socket, token)))
    }

    fn spawn(
        url: &str,
        doc: Doc,
        session: Arc<dyn Session>,
        listener: Arc<dyn Listener>,
        options: Options,
        first: Option<(WebSocket<Stream>, String)>,
    ) -> Result<LiveDoc, ConnectError> {
        let sync = SyncDoc::new(doc);
        // Edits from an earlier run: into the document (before the observer, so they aren't
        // queued twice) and the queue.
        let mut queue = VecDeque::new();
        let mut unusable = Vec::new();
        for (key, update) in options.restored {
            let applied = yrs::Update::decode_v1(&update)
                .map(|u| sync.doc().transact_mut().apply_update(u).is_ok())
                .unwrap_or(false);
            if applied {
                queue.push_back(Entry {
                    seq: queue.len() as u64 + 1,
                    key: Some(key),
                    update,
                });
            } else {
                unusable.push(key);
            }
        }
        if let (Some(o), false) = (&options.outbox, unusable.is_empty()) {
            o.confirmed(&unusable);
        }
        let shared = Arc::new(Shared {
            inner: Mutex::new(Inner {
                queued: queue.len(),
                ..Inner::default()
            }),
            wake: Condvar::new(),
            listener,
        });
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let observer =
            Origin::from(format!("nv-sync:live:{}", NEXT.fetch_add(1, Ordering::Relaxed)).as_str());
        {
            let shared = shared.clone();
            sync.doc()
                .observe_update_v1(observer.clone(), move |txn, e| {
                    if txn.origin().map(|o| o.as_ref()) != Some(REMOTE_ORIGIN.as_bytes()) {
                        shared.lock().fresh.push(e.update.clone());
                        shared.wake.notify_all();
                    }
                })
                .map_err(|e| ConnectError::Network(format!("the document is busy: {e}")))?;
        }
        let worker = Worker {
            url: url.to_string(),
            sync: sync.clone(),
            shared: shared.clone(),
            session,
            outbox: options.outbox.clone(),
            backoff: options.backoff,
            auth_retries: options.auth_retries,
            next_seq: queue.len() as u64 + 1,
            queue,
        };
        let thread = std::thread::Builder::new()
            .name("nv-sync".into())
            .spawn(move || worker.run(first))
            .map_err(|e| ConnectError::Network(e.to_string()))?;
        Ok(LiveDoc {
            sync,
            shared,
            outbox: options.outbox,
            thread: Some(thread),
            observer,
        })
    }

    /// The document. Any transaction on it without `REMOTE_ORIGIN` is a local edit: the update
    /// observer queues it (and keeps it in the outbox) and sends it, exactly as
    /// `apply_local_update` does. Don't use `REMOTE_ORIGIN` for local edits: they wouldn't be sent.
    pub fn doc(&self) -> &Doc {
        self.sync.doc()
    }

    /// The hooks run around every remote update, on the connection's thread (see `RemoteHook`).
    /// The handle stays usable after `close()` (nothing more is applied then).
    pub fn remote_hooks(&self) -> RemoteHooks {
        self.sync.remote_hooks().clone()
    }

    /// Apply a local edit made elsewhere (a Yjs update); it is sent to the server.
    pub fn apply_local_update(&self, update: &[u8]) -> Result<(), crate::SyncError> {
        let u = yrs::Update::decode_v1(update)
            .map_err(|e| crate::SyncError::Protocol(e.to_string()))?;
        self.sync
            .doc()
            .transact_mut()
            .apply_update(u)
            .map_err(|e| crate::SyncError::Protocol(e.to_string()))
    }

    /// Set this client's presence (JSON) and announce it (now if connected, else on connecting).
    pub fn set_presence(&self, json: &str) {
        let m = self.sync.set_presence(json);
        self.shared.lock().control.push(m);
        self.shared.wake.notify_all();
    }

    pub fn presence(&self) -> Vec<(u64, String)> {
        self.sync.presence()
    }

    /// Local edits the server hasn't confirmed yet.
    pub fn unconfirmed(&self) -> usize {
        let i = self.shared.lock();
        i.queued + i.fresh.len()
    }

    /// Stop: close the socket (or stop waiting to reconnect) and end the thread. Returns
    /// promptly: if the thread is stuck opening a socket, it is left to finish on its own
    /// (silently) after at most a second. The listener hears `Closed { code: 1000 }` last
    /// (unless the connection had already ended).
    pub fn close(&mut self) {
        let Some(thread) = self.thread.take() else {
            return;
        };
        self.shared.lock().stop = true;
        self.shared.wake.notify_all();
        // Called from the listener on the thread itself: it stops when the callback returns.
        if thread.thread().id() != std::thread::current().id() {
            let deadline = Instant::now() + CLOSE_WAIT;
            let mut i = self.shared.lock();
            while !i.exited {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                i = self
                    .shared
                    .wake
                    .wait_timeout(i, deadline - now)
                    .unwrap_or_else(|e| e.into_inner())
                    .0;
            }
            let exited = i.exited;
            drop(i);
            if exited {
                let _ = thread.join();
            }
        }
        // Edits the thread didn't take: keep them for next time.
        let fresh = std::mem::take(&mut self.shared.lock().fresh);
        if let (Some(o), false) = (&self.outbox, fresh.is_empty()) {
            o.keep(&fresh);
        }
        self.shared.report(Status::Closed {
            code: 1000,
            reason: "closed".into(),
        });
        let _ = self.sync.doc().unobserve_update_v1(self.observer.clone());
    }
}

impl Drop for LiveDoc {
    fn drop(&mut self) {
        self.close();
    }
}

/// A local edit waiting for the server's receipt.
struct Entry {
    /// Order in this run, from 1.
    seq: u64,
    /// Its key in the outbox, if kept there.
    key: Option<i64>,
    update: Vec<u8>,
}

/// How a connection ended.
enum End {
    Stopped,
    Closed { code: u16, reason: String },
    Lost(String),
}

/// The connection's thread.
struct Worker {
    url: String,
    sync: SyncDoc,
    shared: Arc<Shared>,
    session: Arc<dyn Session>,
    outbox: Option<Arc<dyn Outbox>>,
    backoff: Backoff,
    auth_retries: u32,
    queue: VecDeque<Entry>,
    next_seq: u64,
}

impl Worker {
    fn run(mut self, mut first: Option<(WebSocket<Stream>, String)>) {
        // Tries in a row that failed (since the last sync), and 4401s in a row.
        let mut failures = 0u32;
        let mut auth_failures = 0u32;
        // The token the server refused: the next one is a refresh.
        let mut rejected: Option<String> = None;
        loop {
            if self.shared.stopped() {
                break;
            }
            let (end, synced, token) = match first.take() {
                Some((socket, token)) => {
                    let (synced, end) = self.connection(socket);
                    (end, synced, token)
                }
                None => {
                    self.shared.report(Status::Connecting { attempt: failures });
                    let token = match rejected.take() {
                        Some(bad) => self.session.refresh(&bad),
                        None => self.session.token(),
                    };
                    let token = match token {
                        Ok(t) => t,
                        Err(AuthError::SignedOut) => {
                            self.shared.report(Status::Closed {
                                code: 4401,
                                reason: "signed out".into(),
                            });
                            break;
                        }
                        Err(AuthError::Unavailable(e)) => {
                            if !self.back_off(&mut failures, None, e) {
                                break;
                            }
                            continue;
                        }
                    };
                    match open_socket(&self.url, &token) {
                        Ok(socket) => {
                            let (synced, end) = self.connection(socket);
                            (end, synced, token)
                        }
                        Err(ConnectError::Refused(401)) => (
                            End::Closed {
                                code: 4401,
                                reason: "Unauthorized".into(),
                            },
                            false,
                            token,
                        ),
                        Err(ConnectError::Refused(403)) => (
                            End::Closed {
                                code: 4403,
                                reason: "Forbidden".into(),
                            },
                            false,
                            token,
                        ),
                        Err(e) => (End::Lost(e.to_string()), false, token),
                    }
                }
            };
            if synced {
                failures = 0;
                auth_failures = 0;
            }
            let go_on = match end {
                End::Stopped => false,
                End::Closed { code: 4403, reason } => {
                    self.shared.report(Status::Closed { code: 4403, reason });
                    false
                }
                End::Closed { code: 4401, reason } => {
                    rejected = Some(token);
                    auth_failures += 1;
                    if auth_failures <= self.auth_retries {
                        self.shared.report(Status::Reconnecting {
                            attempt: failures + 1,
                            in_ms: 0,
                            code: Some(4401),
                            reason,
                        });
                        true
                    } else {
                        self.back_off(&mut failures, Some(4401), reason)
                    }
                }
                End::Closed { code, reason } => self.back_off(&mut failures, Some(code), reason),
                End::Lost(reason) => self.back_off(&mut failures, None, reason),
            };
            if !go_on {
                break;
            }
        }
        // Keep what's left, and say goodbye (unless an end was reported already).
        self.take_fresh();
        if self.shared.stopped() {
            self.shared.report(Status::Closed {
                code: 1000,
                reason: "closed".into(),
            });
        }
        self.shared.lock().exited = true;
        self.shared.wake.notify_all();
    }

    /// Report the wait, then wait (keeping local edits meanwhile). False when stopped.
    fn back_off(&mut self, failures: &mut u32, code: Option<u16>, reason: String) -> bool {
        let delay = self.backoff.delay(*failures);
        *failures += 1;
        self.shared.report(Status::Reconnecting {
            attempt: *failures,
            in_ms: delay.as_millis() as u64,
            code,
            reason,
        });
        let deadline = Instant::now() + delay;
        loop {
            self.take_fresh();
            let i = self.shared.lock();
            if i.stop {
                return false;
            }
            if !i.fresh.is_empty() {
                continue;
            }
            let now = Instant::now();
            if now >= deadline {
                return true;
            }
            let _ = self.shared.wake.wait_timeout(i, deadline - now);
        }
    }

    /// Move new local edits into the queue, keeping them in the outbox.
    fn take_fresh(&mut self) {
        let fresh = {
            let mut i = self.shared.lock();
            // Counted as queued at once, so `unconfirmed()` never misses them.
            i.queued += i.fresh.len();
            std::mem::take(&mut i.fresh)
        };
        if fresh.is_empty() {
            return;
        }
        let keys = match &self.outbox {
            Some(o) => o.keep(&fresh),
            None => vec![None; fresh.len()],
        };
        for (i, update) in fresh.into_iter().enumerate() {
            self.queue.push_back(Entry {
                seq: self.next_seq,
                key: keys.get(i).copied().flatten(),
                update,
            });
            self.next_seq += 1;
        }
    }

    /// The server has every edit up to `seq`.
    fn confirm(&mut self, seq: u64) {
        let mut keys = Vec::new();
        while self.queue.front().is_some_and(|e| e.seq <= seq) {
            keys.extend(self.queue.pop_front().and_then(|e| e.key));
        }
        if let (Some(o), false) = (&self.outbox, keys.is_empty()) {
            o.confirmed(&keys);
        }
        self.shared.lock().queued = self.queue.len();
    }

    /// One connection, until it ends. Returns whether it synced, and how it ended.
    fn connection(&mut self, mut socket: WebSocket<Stream>) -> (bool, End) {
        self.shared.report(Status::Connected);
        set_read_timeout(&socket, Some(POLL));
        // Presence set before now goes out with the hello.
        self.shared.lock().control.clear();
        let mut out = self.sync.hello();
        // One entry per step 1 sent, answered in order: the last edit it confirms.
        let mut receipts: VecDeque<Option<u64>> = VecDeque::from([None]);
        let mut synced = false;
        let mut sent_upto = 0u64;
        let mut last_receipt: Option<Instant> = None;
        let lost = |e: tungstenite::Error| End::Lost(e.to_string());
        loop {
            if self.shared.stopped() {
                let _ = socket.close(None);
                let _ = socket.flush();
                return (synced, End::Stopped);
            }
            self.take_fresh();
            out.append(&mut self.shared.lock().control);
            if synced {
                let from = sent_upto;
                for e in self.queue.iter().filter(|e| e.seq > from) {
                    out.push(SyncDoc::update_message(e.update.clone()));
                    sent_upto = e.seq;
                }
                let unconfirmed = self.queue.back().is_some_and(|e| e.seq <= sent_upto);
                if unconfirmed
                    && receipts.is_empty()
                    && last_receipt.is_none_or(|t| t.elapsed() >= RECEIPT_EVERY)
                {
                    out.push(self.sync.step1());
                    receipts.push_back(Some(sent_upto));
                    last_receipt = Some(Instant::now());
                }
            }
            for m in out.drain(..) {
                if let Err(e) = socket.write(WsMessage::Binary(m.into())) {
                    if !would_block(&e) {
                        return (synced, lost(e));
                    }
                }
            }
            if let Err(e) = socket.flush() {
                if !would_block(&e) {
                    return (synced, lost(e));
                }
            }
            match socket.read() {
                Ok(WsMessage::Binary(data)) => match self.sync.handle(&data) {
                    Ok(h) => {
                        out.extend(h.replies);
                        let first_sync = h.synced && !synced;
                        if h.synced {
                            if let Some(Some(seq)) = receipts.pop_front() {
                                self.confirm(seq);
                            }
                        }
                        if (h.doc_changed || first_sync) && !self.shared.ended() {
                            self.shared.listener.on_doc_changed();
                        }
                        if first_sync {
                            synced = true;
                            self.shared.report(Status::Synced);
                        }
                        if h.awareness_changed && !self.shared.ended() {
                            self.shared.listener.on_presence_changed();
                        }
                    }
                    Err(e) => return (synced, End::Lost(e.to_string())),
                },
                Ok(WsMessage::Close(frame)) => {
                    let (code, reason) = frame
                        .map(|f| (u16::from(f.code), f.reason.to_string()))
                        .unwrap_or((u16::from(CloseCode::Status), String::new()));
                    let _ = socket.flush();
                    return (synced, End::Closed { code, reason });
                }
                Ok(_) => {}
                Err(e) if would_block(&e) => {}
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return (
                        synced,
                        End::Closed {
                            code: u16::from(CloseCode::Abnormal),
                            reason: String::new(),
                        },
                    );
                }
                Err(e) => return (synced, lost(e)),
            }
        }
    }
}
