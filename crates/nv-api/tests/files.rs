//! Upload and file-link calls of the client against a scripted transport.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use nv_api::{
    sign_upload_path, ApiError, BinaryResponse, Client, DownloadRequest, FileKey, Request,
    Response, Transport, UploadRequest,
};
use serde_json::{json, Value};

const ID: &str = "0123456789abcdef0123456789abcdef";

#[allow(clippy::type_complexity)]
#[derive(Clone, Default)]
struct Script {
    replies: Arc<Mutex<VecDeque<Result<Response, String>>>>,
    downloads: Arc<Mutex<VecDeque<Result<BinaryResponse, String>>>>,
    seen: Arc<Mutex<Vec<Request>>>,
    /// (url, bearer, X-Filename, bytes) of each upload.
    uploads: Arc<Mutex<Vec<(String, Option<String>, String, Vec<u8>)>>>,
    fetched: Arc<Mutex<Vec<String>>>,
}

impl Script {
    fn reply(&self, status: u16, body: Value) -> &Self {
        self.replies.lock().unwrap().push_back(Ok(Response {
            status,
            body: body.to_string(),
            request_id: None,
        }));
        self
    }
    fn bytes(&self, status: u16, body: &[u8], content_type: Option<&str>) -> &Self {
        self.downloads.lock().unwrap().push_back(Ok(BinaryResponse {
            status,
            body: body.to_vec(),
            content_type: content_type.map(String::from),
        }));
        self
    }
    fn paths(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|r| {
                format!(
                    "{} {}",
                    r.method,
                    r.url.trim_start_matches("http://localhost:4417/api")
                )
            })
            .collect()
    }
}

impl Transport for Script {
    fn send(&self, req: &Request) -> Result<Response, String> {
        self.seen.lock().unwrap().push(req.clone());
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("an unscripted request: {} {}", req.method, req.url))
    }
    fn upload(&self, req: &UploadRequest<'_>) -> Result<Response, String> {
        self.uploads.lock().unwrap().push((
            req.url.clone(),
            req.bearer.clone(),
            req.filename.clone(),
            req.data.to_vec(),
        ));
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("an unscripted upload: {}", req.url))
    }
    fn download(&self, req: &DownloadRequest) -> Result<BinaryResponse, String> {
        self.fetched.lock().unwrap().push(req.url.clone());
        self.downloads
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("an unscripted download: {}", req.url))
    }
}

fn client() -> (Client, Script) {
    let s = Script::default();
    s.reply(
        200,
        json!({ "accessToken": "acc", "expiresIn": 900, "refreshToken": "ref",
                "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } }),
    );
    let c = Client::with_transport("http://localhost:4417", Box::new(s.clone()));
    c.login("a@b.c", "pw").unwrap();
    (c, s)
}

fn far() -> u64 {
    // Far enough ahead that no key here counts as lapsed.
    4_000_000_000
}

#[test]
fn upload_sends_raw_bytes_with_the_encoded_name_and_page() {
    let (c, s) = client();
    s.reply(
        200,
        json!({ "id": ID, "url": format!("/uploads/{ID}.png"), "name": "my cat é.png", "mime": "image/png", "size": 4 }),
    );
    let f = c
        .upload_file("w 1", Some("p1"), "my cat é.png", &[1, 2, 3, 4])
        .unwrap();
    assert_eq!(f.url, format!("/uploads/{ID}.png"));
    assert_eq!((f.mime.as_str(), f.size), ("image/png", 4));
    let up = s.uploads.lock().unwrap().clone();
    assert_eq!(up.len(), 1);
    assert_eq!(
        up[0].0,
        "http://localhost:4417/api/workspaces/w%201/files?pageId=p1"
    );
    assert_eq!(up[0].1.as_deref(), Some("acc"));
    assert_eq!(up[0].2, "my%20cat%20%C3%A9.png");
    assert_eq!(up[0].3, vec![1, 2, 3, 4]);

    // Without a page: no query.
    s.reply(200, json!({ "id": ID, "url": format!("/uploads/{ID}"), "name": "x", "mime": "application/octet-stream", "size": 1 }));
    c.upload_file("w1", None, "", &[9]).unwrap();
    let up = s.uploads.lock().unwrap().clone();
    assert_eq!(up[1].0, "http://localhost:4417/api/workspaces/w1/files");
    assert_eq!(up[1].2, "file");
}

#[test]
fn upload_refuses_too_large_and_empty_before_sending() {
    let (c, s) = client();
    let big = vec![0u8; 25 * 1024 * 1024 + 1];
    match c.upload_file("w1", None, "big.zip", &big) {
        Err(ApiError::Http {
            status: 413,
            code,
            message,
            ..
        }) => {
            assert_eq!(code.as_deref(), Some("file_too_large"));
            assert!(message.contains("25 MB") && message.contains("big.zip"));
        }
        other => panic!("{other:?}"),
    }
    // Exactly 25 MB goes.
    s.reply(
        200,
        json!({ "id": ID, "url": "/uploads/x", "name": "a", "mime": "", "size": 1 }),
    );
    c.upload_file("w1", None, "a.zip", &big[..25 * 1024 * 1024])
        .unwrap();
    assert!(matches!(
        c.upload_file("w1", None, "e.txt", &[]),
        Err(ApiError::Http { status: 400, .. })
    ));
    assert_eq!(s.uploads.lock().unwrap().len(), 1);
}

#[test]
fn upload_errors_and_a_401_refreshes_once() {
    let (c, s) = client();
    s.reply(403, json!({ "error": "You have view-only access" }));
    match c.upload_file("w1", Some("p1"), "a.png", &[1]) {
        Err(ApiError::Http {
            status: 403,
            message,
            ..
        }) => {
            assert_eq!(message, "You have view-only access")
        }
        other => panic!("{other:?}"),
    }
    s.reply(401, json!({ "error": "expired" }));
    s.reply(
        200,
        json!({ "accessToken": "acc2", "expiresIn": 900, "refreshToken": "ref2",
                "user": { "id": "u1", "email": "a@b.c", "name": "Ann", "color": "#123456", "emailVerified": true } }),
    );
    s.reply(
        200,
        json!({ "id": ID, "url": "/uploads/x", "name": "a", "mime": "", "size": 1 }),
    );
    c.upload_file("w1", None, "a.png", &[1]).unwrap();
    let up = s.uploads.lock().unwrap().clone();
    assert_eq!(up.last().unwrap().1.as_deref(), Some("acc2"));
    assert_eq!(s.paths().last().unwrap(), "POST /auth/refresh");
}

#[test]
fn signing_matches_the_web() {
    // HMAC-SHA-256("keykeykey", "<id>.png") first 32 hex, computed with node:crypto.
    let key = FileKey {
        u: "u 1".into(),
        e: 1234,
        k: "keykeykey".into(),
        l: None,
    };
    assert_eq!(
        sign_upload_path(&format!("/uploads/{ID}.png"), &key),
        format!("/uploads/{ID}.png?u=u%201&e=1234&s=70989c78f35aa78386b9c4fe524b4f02")
    );
    let locked = FileKey {
        l: Some("0123456789abcdef01234567".into()),
        ..key.clone()
    };
    assert!(sign_upload_path(&format!("/uploads/{ID}.png"), &locked)
        .contains("&e=1234&l=0123456789abcdef01234567&s="));
    // Not an upload path: unchanged.
    assert_eq!(sign_upload_path("https://x/y.png", &key), "https://x/y.png");
    assert_eq!(sign_upload_path("/uploads/../x", &key), "/uploads/../x");
}

#[test]
fn file_links_fetch_one_key_and_reuse_it() {
    let (c, s) = client();
    s.reply(200, json!({ "u": "u1", "e": far(), "k": "keykeykey" }));
    let url = c
        .signed_file_url(&format!("/uploads/{ID}.png"), false)
        .unwrap();
    assert!(url.starts_with(&format!(
        "http://localhost:4417/uploads/{ID}.png?u=u1&e={}&s=",
        far()
    )));
    assert_eq!(s.paths().last().unwrap(), "GET /files/key");
    // Second call: no request.
    let n = s.paths().len();
    c.signed_file_url(&format!("/uploads/{ID}.png"), false)
        .unwrap();
    assert_eq!(s.paths().len(), n);
    // An external image is left alone, with no request.
    assert_eq!(
        c.signed_file_url("https://x/y.png", false).unwrap(),
        "https://x/y.png"
    );
    assert_eq!(s.paths().len(), n);
}

#[test]
fn locked_key_is_used_when_asked_and_falls_back_when_locked() {
    let (c, s) = client();
    s.reply(
        200,
        json!({ "u": "u1", "e": far(), "k": "kk", "l": "0123456789abcdef01234567" }),
    );
    let url = c
        .signed_file_url(&format!("/uploads/{ID}.png"), true)
        .unwrap();
    assert!(url.contains("&l=0123456789abcdef01234567&"));
    assert_eq!(s.paths().last().unwrap(), "GET /locked-notes/file-key");
    // Relocked: forgotten; the server refuses the locked key, the normal one is used.
    c.forget_locked_file_key();
    s.reply(
        403,
        json!({ "error": "Unlock your locked notes first", "code": "locked" }),
    );
    s.reply(200, json!({ "u": "u1", "e": far(), "k": "kk" }));
    let url = c
        .signed_file_url(&format!("/uploads/{ID}.png"), true)
        .unwrap();
    assert!(!url.contains("&l="));
}

#[test]
fn a_lapsing_key_is_replaced() {
    let (c, s) = client();
    s.reply(200, json!({ "u": "u1", "e": 10, "k": "old" }));
    s.reply(200, json!({ "u": "u1", "e": far(), "k": "new" }));
    // The first key is already in the past, so the second call asks again.
    c.signed_file_url(&format!("/uploads/{ID}.png"), false)
        .unwrap();
    let url = c
        .signed_file_url(&format!("/uploads/{ID}.png"), false)
        .unwrap();
    assert!(url.contains(&format!("e={}", far())));
}

#[test]
fn download_reads_bytes_and_mime_and_errors() {
    let (c, s) = client();
    s.reply(200, json!({ "u": "u1", "e": far(), "k": "kk" }));
    s.bytes(200, &[0x89, b'P', b'N', b'G'], Some("Image/PNG; charset=x"));
    let f = c
        .download_file(&format!("/uploads/{ID}.png"), false)
        .unwrap();
    assert_eq!(f.bytes, vec![0x89, b'P', b'N', b'G']);
    assert_eq!(f.mime, "image/png");
    assert!(s.fetched.lock().unwrap()[0].contains("/uploads/"));

    s.bytes(200, b"x", None);
    assert_eq!(
        c.download_file(&format!("/uploads/{ID}"), false)
            .unwrap()
            .mime,
        "application/octet-stream"
    );
    s.bytes(
        403,
        b"This link has expired, or you do not have access to this file",
        Some("text/plain"),
    );
    match c.download_file(&format!("/uploads/{ID}.png"), false) {
        Err(ApiError::Http {
            status: 403,
            message,
            ..
        }) => assert!(message.starts_with("This link")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn file_info_reads_the_metadata() {
    let (c, s) = client();
    s.reply(200, json!({ "id": ID, "url": format!("/uploads/{ID}.pdf"), "name": "a.pdf", "mime": "application/pdf", "size": 10 }));
    let f = c.file_info(ID).unwrap();
    assert_eq!(f.name, "a.pdf");
    assert_eq!(s.paths().last().unwrap(), &format!("GET /files/{ID}"));
}
