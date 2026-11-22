//! The typed REST client for today's server (server/routes/, the Rust side of src/api.ts).
//!
//! Sessions work as in the web app: a short-lived access token kept in memory and a rotating
//! refresh token the app stores securely (`Client::session_refresh_token`). The access token is
//! refreshed shortly before it expires and once after a 401; safe requests (GET) are retried on
//! network errors and 502/503/504; writes are never retried, so they can't apply twice.
//!
//! The client is blocking: the core calls it from its own threads, never the UI thread.

mod tree;
pub mod types;

use std::sync::{Arc, Mutex};
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

/// HTTP over ureq with rustls (ring), certificates checked by the system's verifier.
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl Default for UreqTransport {
    fn default() -> Self {
        let tls = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::Rustls)
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .build();
        let agent = ureq::Agent::config_builder()
            .tls_config(tls)
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
        self.refresh_locked()
    }

    /// A refresh, with `refreshing` held.
    fn refresh_locked(&self) -> Result<AuthSession, ApiError> {
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

    /// The access token if it has over 30 s left (and isn't `except`).
    fn fresh_access(&self, except: Option<&str>) -> Option<String> {
        let t = self.tokens.lock().unwrap();
        let (tok, exp) = t.access.as_ref()?;
        (exp.saturating_duration_since(Instant::now()) > Duration::from_secs(30)
            && Some(tok.as_str()) != except)
            .then(|| tok.clone())
    }

    /// A valid access token, refreshed first when it has under 30 s left. Safe to call from
    /// several threads: one refreshes, the others wait for it and use its token.
    pub fn access_token(&self) -> Result<String, ApiError> {
        if let Some(t) = self.fresh_access(None) {
            return Ok(t);
        }
        let _one = self.refreshing.lock().unwrap();
        if let Some(t) = self.fresh_access(None) {
            return Ok(t);
        }
        Ok(self.refresh_locked()?.access_token)
    }

    /// A token to replace `rejected`, which the server refused (a collab socket closed with
    /// 4401): another one if a refresh since gave a newer token, else a refresh.
    pub fn access_token_replacing(&self, rejected: &str) -> Result<String, ApiError> {
        let _one = self.refreshing.lock().unwrap();
        if let Some(t) = self.fresh_access(Some(rejected)) {
            return Ok(t);
        }
        Ok(self.refresh_locked()?.access_token)
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

    /// Change some of a task (PATCH /tasks/:id with the set fields; see `TaskPatch`). Answers
    /// with the task as the server now has it.
    pub fn patch_task(&self, task_id: &str, patch: &TaskPatch) -> Result<Task, ApiError> {
        self.update_task(task_id, &patch.to_value())
    }

    /// Done tasks older than the list's 30 days, newest first (GET /workspaces/:id/tasks/completed):
    /// at most 100 completed before (an ISO instant: the last one's `completed_at`).
    pub fn completed_tasks(
        &self,
        workspace_id: &str,
        before: Option<&str>,
    ) -> Result<Vec<Task>, ApiError> {
        let mut path = format!(
            "/workspaces/{}/tasks/completed",
            encode_component(workspace_id)
        );
        if let Some(b) = before {
            path.push_str(&format!("?before={}", encode_component(b)));
        }
        self.call("GET", &path, None)
    }

    /// The notes written under the task on its page, as Markdown (GET /tasks/:id/notes): bullets,
    /// checklists (`- [ ] x`) and so on, subtasks left out. Empty without notes or a page.
    pub fn task_notes(&self, task_id: &str) -> Result<String, ApiError> {
        let v: Value = self.call(
            "GET",
            &format!("/tasks/{}/notes", encode_component(task_id)),
            None,
        )?;
        Ok(v["markdown"].as_str().unwrap_or_default().to_string())
    }

    /// The workspace's tags, by name (GET /workspaces/:id/tags).
    pub fn tags(&self, workspace_id: &str) -> Result<Vec<Tag>, ApiError> {
        self.call(
            "GET",
            &format!("/workspaces/{}/tags", encode_component(workspace_id)),
            None,
        )
    }

    /// A tag by name (POST /workspaces/:id/tags; members). A name that exists (any case) returns
    /// that tag, a leading # is dropped, at most 40 characters. `color` is #rrggbb; none picks one.
    pub fn create_tag(
        &self,
        workspace_id: &str,
        name: &str,
        color: Option<&str>,
    ) -> Result<Tag, ApiError> {
        let mut body = json!({ "name": name });
        if let Some(c) = color {
            body["color"] = json!(c);
        }
        self.call(
            "POST",
            &format!("/workspaces/{}/tags", encode_component(workspace_id)),
            Some(&body),
        )
    }

    /// The workspace's teams and subteams (GET /workspaces/:id/teams).
    pub fn teams(&self, workspace_id: &str) -> Result<Vec<Team>, ApiError> {
        self.call(
            "GET",
            &format!("/workspaces/{}/teams", encode_component(workspace_id)),
            None,
        )
    }

    /// The workspace's members (GET /workspaces/:id/members; its pending invites, which only
    /// admins get, are left out).
    pub fn members(&self, workspace_id: &str) -> Result<Vec<Member>, ApiError> {
        let v: Value = self.call(
            "GET",
            &format!("/workspaces/{}/members", encode_component(workspace_id)),
            None,
        )?;
        serde_json::from_value(v["members"].clone()).map_err(|e| ApiError::Decode(e.to_string()))
    }

    /// The caller's reminders on a task (GET /tasks/:id/reminders), oldest first.
    pub fn reminders(&self, task_id: &str) -> Result<Vec<Reminder>, ApiError> {
        self.call(
            "GET",
            &format!("/tasks/{}/reminders", encode_component(task_id)),
            None,
        )
    }

    /// Add a reminder to a task (POST /tasks/:id/reminders; at most 10 per task).
    pub fn add_reminder(&self, task_id: &str, spec: &ReminderSpec) -> Result<Reminder, ApiError> {
        let body = serde_json::to_value(spec).map_err(|e| ApiError::Decode(e.to_string()))?;
        self.call(
            "POST",
            &format!("/tasks/{}/reminders", encode_component(task_id)),
            Some(&body),
        )
    }

    /// Change a reminder (PATCH /reminders/:id).
    pub fn update_reminder(
        &self,
        reminder_id: &str,
        spec: &ReminderSpec,
    ) -> Result<Reminder, ApiError> {
        let body = serde_json::to_value(spec).map_err(|e| ApiError::Decode(e.to_string()))?;
        self.call(
            "PATCH",
            &format!("/reminders/{}", encode_component(reminder_id)),
            Some(&body),
        )
    }

    /// Remove a reminder (DELETE /reminders/:id).
    pub fn delete_reminder(&self, reminder_id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/reminders/{}", encode_component(reminder_id)),
            None,
        )?;
        Ok(())
    }

    /// Change a task's title (PATCH `{ title }`; the server trims it).
    pub fn set_task_title(&self, task_id: &str, title: &str) -> Result<Task, ApiError> {
        self.update_task(task_id, &json!({ "title": title }))
    }

    /// Delete a task (DELETE /tasks/:id); its subtasks go with it. A task that is already gone
    /// (or never reached the server) answers 404.
    pub fn delete_task(&self, task_id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/tasks/{}", encode_component(task_id)),
            None,
        )?;
        Ok(())
    }

    /// Full-text search over the workspace's pages and tasks (GET /workspaces/:id/search?q=&limit=).
    /// The server trims the query to 200 characters, matches each term as a prefix, stemmed, all
    /// terms required, and `limit` is 1 to 50 (default 20; applies to pages and tasks each).
    pub fn search(
        &self,
        workspace_id: &str,
        query: &str,
        limit: Option<u32>,
    ) -> Result<SearchResult, ApiError> {
        let mut path = format!(
            "/workspaces/{}/search?q={}",
            encode_component(workspace_id),
            encode_component(query)
        );
        if let Some(l) = limit {
            path.push_str(&format!("&limit={l}"));
        }
        self.call("GET", &path, None)
    }

    /// A page's comment threads with their comments, oldest thread first (GET /pages/:id/comments).
    pub fn page_comments(&self, page_id: &str) -> Result<Vec<CommentThread>, ApiError> {
        self.call(
            "GET",
            &format!("/pages/{}/comments", encode_component(page_id)),
            None,
        )
    }

    /// Start a thread (POST /pages/:id/comments; members and up). `thread_id` is a UUID the
    /// caller chose, the id of the `comment` mark; sending it again returns the same thread.
    pub fn add_comment_thread(
        &self,
        page_id: &str,
        thread_id: &str,
        quote: &str,
        body: &str,
    ) -> Result<CommentThread, ApiError> {
        self.call(
            "POST",
            &format!("/pages/{}/comments", encode_component(page_id)),
            Some(&json!({ "threadId": thread_id, "quote": quote, "body": body })),
        )
    }

    /// Reply to a thread (POST /comment-threads/:id/replies); this reopens a resolved thread.
    pub fn reply_to_thread(&self, thread_id: &str, body: &str) -> Result<CommentThread, ApiError> {
        self.call(
            "POST",
            &format!("/comment-threads/{}/replies", encode_component(thread_id)),
            Some(&json!({ "body": body })),
        )
    }

    /// Resolve or reopen a thread (PATCH /comment-threads/:id; members and up).
    pub fn set_thread_resolved(
        &self,
        thread_id: &str,
        resolved: bool,
    ) -> Result<CommentThread, ApiError> {
        self.call(
            "PATCH",
            &format!("/comment-threads/{}", encode_component(thread_id)),
            Some(&json!({ "resolved": resolved })),
        )
    }

    /// Delete a whole thread (DELETE /comment-threads/:id): its starter or a workspace admin.
    pub fn delete_comment_thread(&self, thread_id: &str) -> Result<(), ApiError> {
        let _: Value = self.call(
            "DELETE",
            &format!("/comment-threads/{}", encode_component(thread_id)),
            None,
        )?;
        Ok(())
    }

    /// Edit your own comment (PATCH /comments/:id); answers with its thread.
    pub fn edit_comment(&self, comment_id: &str, body: &str) -> Result<CommentThread, ApiError> {
        self.call(
            "PATCH",
            &format!("/comments/{}", encode_component(comment_id)),
            Some(&json!({ "body": body })),
        )
    }

    /// Delete one comment (DELETE /comments/:id): its author or an admin. Deleting a thread's
    /// last comment deletes the thread; answers whether that happened.
    pub fn delete_comment(&self, comment_id: &str) -> Result<bool, ApiError> {
        let v: Value = self.call(
            "DELETE",
            &format!("/comments/{}", encode_component(comment_id)),
            None,
        )?;
        Ok(v["threadDeleted"].as_bool().unwrap_or(false))
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
