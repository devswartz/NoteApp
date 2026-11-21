//! The typed REST client for today's server (server/routes/, the Rust side of src/api.ts).
//!
//! Sessions work as in the web app: a short-lived access token kept in memory and a rotating
//! refresh token the app stores securely (`Client::session_refresh_token`). The access token is
//! refreshed shortly before it expires and once after a 401; safe requests (GET) are retried on
//! network errors and 502/503/504; writes are never retried, so they can't apply twice.
//!
//! The client is blocking: the core calls it from its own threads, never the UI thread.

pub mod types;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

pub use types::*;

/// Why a request failed.
#[derive(Debug, Clone, PartialEq)]
pub enum ApiError {
    /// The server couldn't be reached (offline, DNS, TLS, timeout).
    Network(String),
    /// The server answered with an error.
    Http {
        status: u16,
        message: String,
        /// Stable machine-readable code, e.g. `email_unverified`.
        code: Option<String>,
        /// The server's request id (X-Request-Id), to match a report with its log.
        request_id: Option<String>,
    },
    /// No session, or the refresh token was rejected: sign in again.
    SignedOut,
    /// The answer wasn't what this client expects.
    Decode(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Network(e) => write!(f, "network error: {e}"),
            ApiError::Http {
                status, message, ..
            } => write!(f, "{message} ({status})"),
            ApiError::SignedOut => write!(f, "signed out"),
            ApiError::Decode(e) => write!(f, "unexpected response: {e}"),
        }
    }
}
impl std::error::Error for ApiError {}

/// One HTTP exchange, as the transport sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub bearer: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub status: u16,
    pub body: String,
    pub request_id: Option<String>,
}

/// Sends requests. `UreqTransport` in the apps; tests use a scripted one.
pub trait Transport: Send + Sync {
    /// Err only when no response arrived (network error).
    fn send(&self, req: &Request) -> Result<Response, String>;
}

/// HTTP over ureq with rustls.
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl Default for UreqTransport {
    fn default() -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(30)))
            .user_agent(concat!("notivelo-core/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        UreqTransport { agent }
    }
}

impl Transport for UreqTransport {
    fn send(&self, req: &Request) -> Result<Response, String> {
        let auth = req.bearer.as_ref().map(|t| format!("Bearer {t}"));
        let res = match (req.method, &req.body) {
            ("GET", _) => {
                let mut r = self.agent.get(&req.url);
                if let Some(a) = &auth {
                    r = r.header("Authorization", a);
                }
                r.call()
            }
            (m, body) => {
                let mut r = match m {
                    "POST" => self.agent.post(&req.url),
                    "PATCH" => self.agent.patch(&req.url),
                    "PUT" => self.agent.put(&req.url),
                    _ => {
                        let mut r = self.agent.delete(&req.url);
                        if let Some(a) = &auth {
                            r = r.header("Authorization", a);
                        }
                        return finish(r.call());
                    }
                };
                if let Some(a) = &auth {
                    r = r.header("Authorization", a);
                }
                r.header("Content-Type", "application/json")
                    .send(body.as_deref().unwrap_or("{}"))
            }
        };
        finish(res)
    }
}

fn finish(res: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<Response, String> {
    let mut res = res.map_err(|e| e.to_string())?;
    let request_id = res
        .headers()
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let status = res.status().as_u16();
    let body = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
    Ok(Response {
        status,
        body,
        request_id,
    })
}

struct Tokens {
    access: Option<(String, Instant)>,
    refresh: Option<String>,
    user: Option<User>,
}

/// A client for one server.
pub struct Client {
    base: String,
    transport: Box<dyn Transport>,
    tokens: Mutex<Tokens>,
    /// Serialises refreshes: two must never spend the same refresh token.
    refreshing: Mutex<()>,
}

const RETRYABLE: [u16; 3] = [502, 503, 504];

impl Client {
    /// `base` is the server's origin, e.g. `https://app.notiveloapp.com`.
    pub fn new(base: &str) -> Client {
        Client::with_transport(base, Box::new(UreqTransport::default()))
    }

    pub fn with_transport(base: &str, transport: Box<dyn Transport>) -> Client {
        Client {
            base: base.trim_end_matches('/').to_string(),
            transport,
            tokens: Mutex::new(Tokens {
                access: None,
                refresh: None,
                user: None,
            }),
            refreshing: Mutex::new(()),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// The collab socket's URL for a page (`ws(s)://…/collab/<page id>`).
    pub fn collab_url(&self, page_id: &str) -> String {
        let ws = if let Some(rest) = self.base.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.base.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.base.clone()
        };
        format!("{ws}/collab/{}", encode_component(page_id))
    }

    fn adopt(&self, s: &AuthSession) {
        let mut t = self.tokens.lock().unwrap();
        t.access = Some((
            s.access_token.clone(),
            Instant::now() + Duration::from_secs(s.expires_in),
        ));
        t.refresh = Some(s.refresh_token.clone());
        t.user = Some(s.user.clone());
    }

    /// The signed-in user, if any.
    pub fn user(&self) -> Option<User> {
        self.tokens.lock().unwrap().user.clone()
    }

    /// The current refresh token, for the app to keep in secure storage (it rotates on every refresh).
    pub fn session_refresh_token(&self) -> Option<String> {
        self.tokens.lock().unwrap().refresh.clone()
    }

    fn send(
        &self,
        method: &'static str,
        path: &str,
        bearer: Option<String>,
        body: Option<&Value>,
    ) -> Result<Response, ApiError> {
        let req = Request {
            method,
            url: format!("{}/api{path}", self.base),
            bearer,
            body: body.map(|b| b.to_string()),
        };
        let tries = if method == "GET" { 3 } else { 1 };
        let mut i = 0;
        loop {
            match self.transport.send(&req) {
                Ok(r) if i + 1 < tries && RETRYABLE.contains(&r.status) => {}
                Ok(r) => return Ok(r),
                Err(e) if i + 1 >= tries => return Err(ApiError::Network(e)),
                Err(_) => {}
            }
            std::thread::sleep(Duration::from_millis(400 * 3u64.pow(i)));
            i += 1;
        }
    }

    fn decode<T: DeserializeOwned>(res: Response) -> Result<T, ApiError> {
        if !(200..300).contains(&res.status) {
            let data: Value = serde_json::from_str(&res.body).unwrap_or(Value::Null);
            return Err(ApiError::Http {
                status: res.status,
                message: data["error"]
                    .as_str()
                    .map(String::from)
                    .unwrap_or_else(|| format!("Request failed ({})", res.status)),
                code: data["code"].as_str().map(String::from),
                request_id: data["requestId"]
                    .as_str()
                    .map(String::from)
                    .or(res.request_id),
            });
        }
        serde_json::from_str(if res.body.is_empty() {
            "null"
        } else {
            &res.body
        })
        .map_err(|e| ApiError::Decode(e.to_string()))
    }

    fn auth_call(&self, path: &str, body: Value) -> Result<AuthSession, ApiError> {
        let s: AuthSession = Self::decode(self.send("POST", path, None, Some(&body))?)?;
        self.adopt(&s);
        Ok(s)
    }

    pub fn login(&self, email: &str, password: &str) -> Result<AuthSession, ApiError> {
        self.auth_call(
            "/auth/login",
            json!({ "email": email, "password": password }),
        )
    }

    /// Create an account (when the server allows sign-ups). Returns its first session.
    pub fn register(
        &self,
        name: &str,
        email: &str,
        password: &str,
    ) -> Result<AuthSession, ApiError> {
        self.auth_call(
            "/auth/register",
            json!({ "name": name, "email": email, "password": password }),
        )
    }

    /// Resume a stored sign-in: exchange its refresh token for a session.
    pub fn restore(&self, refresh_token: &str) -> Result<AuthSession, ApiError> {
        self.tokens.lock().unwrap().refresh = Some(refresh_token.to_string());
        self.refresh()
    }

    /// Exchange the refresh token for a new session. `SignedOut` when it is rejected.
    pub fn refresh(&self) -> Result<AuthSession, ApiError> {
        let _one = self.refreshing.lock().unwrap();
        let Some(token) = self.tokens.lock().unwrap().refresh.clone() else {
            return Err(ApiError::SignedOut);
        };
        let res = self.send(
            "POST",
            "/auth/refresh",
            None,
            Some(&json!({ "refreshToken": token })),
        )?;
        if res.status == 401 {
            let mut t = self.tokens.lock().unwrap();
            if t.refresh.as_deref() == Some(&token) {
                *t = Tokens {
                    access: None,
                    refresh: None,
                    user: None,
                };
            }
            return Err(ApiError::SignedOut);
        }
        let s: AuthSession = Self::decode(res)?;
        self.adopt(&s);
        Ok(s)
    }

    /// Forget the session and revoke it on the server (best effort).
    pub fn logout(&self) {
        let refresh = {
            let mut t = self.tokens.lock().unwrap();
            let r = t.refresh.take();
            *t = Tokens {
                access: None,
                refresh: None,
                user: None,
            };
            r
        };
        if let Some(r) = refresh {
            let _ = self.send(
                "POST",
                "/auth/logout",
                None,
                Some(&json!({ "refreshToken": r })),
            );
        }
    }

    /// A valid access token, refreshed first when it has under 30 s left.
    pub fn access_token(&self) -> Result<String, ApiError> {
        if let Some((tok, exp)) = &self.tokens.lock().unwrap().access {
            if exp.saturating_duration_since(Instant::now()) > Duration::from_secs(30) {
                return Ok(tok.clone());
            }
        }
        Ok(self.refresh()?.access_token)
    }

    /// An authenticated request: refresh-and-retry once on 401.
    pub fn call<T: DeserializeOwned>(
        &self,
        method: &'static str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<T, ApiError> {
        let res = self.send(method, path, Some(self.access_token()?), body)?;
        if res.status == 401 {
            let token = self.refresh()?.access_token;
            return Self::decode(self.send(method, path, Some(token), body)?);
        }
        Self::decode(res)
    }

    pub fn me(&self) -> Result<User, ApiError> {
        self.call("GET", "/me", None)
    }

    pub fn workspaces(&self) -> Result<Vec<Workspace>, ApiError> {
        self.call("GET", "/workspaces", None)
    }

    /// Notebooks, sections and pages of a workspace that the caller can see.
    pub fn tree(&self, workspace_id: &str) -> Result<Tree, ApiError> {
        self.call(
            "GET",
            &format!("/workspaces/{}/tree", encode_component(workspace_id)),
            None,
        )
    }

    /// The workspace's open tasks (and recently done ones), as the task views list them.
    pub fn tasks(&self, workspace_id: &str) -> Result<Vec<Task>, ApiError> {
        self.call(
            "GET",
            &format!("/workspaces/{}/tasks", encode_component(workspace_id)),
            None,
        )
    }

    pub fn create_task(&self, workspace_id: &str, task: &NewTask) -> Result<Task, ApiError> {
        let body = serde_json::to_value(task).map_err(|e| ApiError::Decode(e.to_string()))?;
        self.call(
            "POST",
            &format!("/workspaces/{}/tasks", encode_component(workspace_id)),
            Some(&body),
        )
    }

    /// Change some of a task's fields (shared/types.ts TaskPatch; `null` clears a field).
    pub fn update_task(&self, task_id: &str, patch: &Value) -> Result<Task, ApiError> {
        self.call(
            "PATCH",
            &format!("/tasks/{}", encode_component(task_id)),
            Some(patch),
        )
    }

    /// A page's stored document (a Yjs update), as the server last saved it.
    pub fn page_doc(&self, page_id: &str) -> Result<Vec<u8>, ApiError> {
        let v: Value = self.call(
            "GET",
            &format!("/pages/{}/doc", encode_component(page_id)),
            None,
        )?;
        let b64 = v["ydoc"]
            .as_str()
            .ok_or_else(|| ApiError::Decode("no ydoc".into()))?;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| ApiError::Decode(e.to_string()))
    }
}

/// `encodeURIComponent`.
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
