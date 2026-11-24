//! Uploaded images and attachments. The truth is the server: `server/routes/files.ts` (upload,
//! metadata, signed-link key, `/uploads/<id><ext>`) and `shared/fileLinks.ts` (the signing); the
//! web's side is `src/editor/upload.ts` and `src/api.ts` (`fileUrl`).
//!
//! The server has no delete route for a file: they stay until the page is gone.

use std::time::{SystemTime, UNIX_EPOCH};

use ring::hmac;

use crate::*;

/// The server's upload limit (`MAX_UPLOAD_BYTES`), which the client also checks first.
pub const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;

/// Keys already fetched: the normal one, and the one for an unlocked sign-in.
#[derive(Default)]
pub(crate) struct FileKeys {
    normal: Option<FileKey>,
    locked: Option<FileKey>,
}

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `/uploads/<32 hex><.ext>` -> the stored name after the slash, like shared/fileLinks.ts
/// `UPLOAD_PATH`.
fn upload_name(path: &str) -> Option<&str> {
    let name = path.strip_prefix("/uploads/")?;
    let (stem, ext) = match name.find('.') {
        Some(i) => (&name[..i], Some(&name[i + 1..])),
        None => (name, None),
    };
    let stem_ok = stem.len() == 32
        && stem
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let ext_ok = ext.is_none_or(|e| {
        (1..=10).contains(&e.len())
            && e.bytes()
                .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
    });
    (stem_ok && ext_ok).then_some(name)
}

/// The signature for one stored file name: the first 32 hex of HMAC-SHA-256(key, name).
pub fn sign_file_name(key: &str, name: &str) -> String {
    let k = hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes());
    let tag = hmac::sign(&k, name.as_bytes());
    let mut out = String::with_capacity(32);
    for b in &tag.as_ref()[..16] {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// `/uploads/<name>` -> the same path with the signature query (`?u=&e=&l=&s=`); anything else
/// unchanged. Like shared/fileLinks.ts `signUploadPath`.
pub fn sign_upload_path(path: &str, key: &FileKey) -> String {
    let Some(name) = upload_name(path) else {
        return path.to_string();
    };
    let l = key
        .l
        .as_ref()
        .map(|l| format!("&l={l}"))
        .unwrap_or_default();
    format!(
        "{path}?u={}&e={}{l}&s={}",
        encode_component(&key.u),
        key.e,
        sign_file_name(&key.k, name)
    )
}

impl Client {
    /// Upload a file (POST /workspaces/:id/files, with `?pageId=` to put it on a page, which needs
    /// edit access to it; a locked page's owner only while unlocked). Over 25 MB is refused here
    /// as the web does (`Http` 413, code `file_too_large`) and an empty file is a 400 (code
    /// `file_empty`), both before anything is sent. The server decides the type from the file
    /// name's extension.
    pub fn upload_file(
        &self,
        workspace_id: &str,
        page_id: Option<&str>,
        filename: &str,
        data: &[u8],
    ) -> Result<UploadedFile, ApiError> {
        let name = if filename.trim().is_empty() {
            "file"
        } else {
            filename
        };
        if data.len() > MAX_UPLOAD_BYTES {
            return Err(ApiError::Http {
                status: 413,
                message: format!("\u{201c}{name}\u{201d} is larger than 25 MB"),
                code: Some("file_too_large".into()),
                request_id: None,
            });
        }
        if data.is_empty() {
            return Err(ApiError::Http {
                status: 400,
                message: format!("\u{201c}{name}\u{201d} is empty"),
                code: Some("file_empty".into()),
                request_id: None,
            });
        }
        let mut path = format!("/workspaces/{}/files", encode_component(workspace_id));
        if let Some(p) = page_id.filter(|p| !p.is_empty()) {
            path.push_str(&format!("?pageId={}", encode_component(p)));
        }
        let send = |token: String| {
            self.transport
                .upload(&UploadRequest {
                    url: format!("{}/api{path}", self.base),
                    bearer: Some(token),
                    filename: encode_component(name),
                    data,
                })
                .map_err(ApiError::Network)
        };
        let res = send(self.access_token()?)?;
        if res.status == 401 {
            let token = self.refresh()?.access_token;
            return Self::decode(send(token)?);
        }
        Self::decode(res)
    }

    /// A file's metadata (GET /files/:id). 404 when it doesn't exist or isn't visible to the user.
    pub fn file_info(&self, file_id: &str) -> Result<UploadedFile, ApiError> {
        self.call(
            "GET",
            &format!("/files/{}", encode_component(file_id)),
            None,
        )
    }

    /// A key for signing links (GET /files/key).
    pub fn file_key(&self) -> Result<FileKey, ApiError> {
        self.call("GET", "/files/key", None)
    }

    /// A key that also opens files on the user's locked pages (GET /locked-notes/file-key);
    /// 403 `locked` while this sign-in is locked.
    pub fn locked_file_key(&self) -> Result<FileKey, ApiError> {
        self.call("GET", "/locked-notes/file-key", None)
    }

    /// Forget the key for an unlocked sign-in (the sign-in locked again or unlocked afresh: links
    /// signed with the old one stop working).
    pub fn forget_locked_file_key(&self) {
        self.file_keys.lock().unwrap().locked = None;
    }

    /// A key good for at least another minute for the signed-in user, from the cache or the server.
    fn usable_key(&self, locked: bool) -> Result<FileKey, ApiError> {
        let user = self.user().map(|u| u.id);
        let good = |k: &FileKey| k.e > now_s() + 60 && user.as_deref().is_none_or(|u| u == k.u);
        if locked {
            let cached = self.file_keys.lock().unwrap().locked.clone();
            if let Some(k) = cached.filter(good) {
                return Ok(k);
            }
            // Only while unlocked: locked (403) or any other failure falls back to the normal key.
            if let Ok(k) = self.locked_file_key() {
                self.file_keys.lock().unwrap().locked = Some(k.clone());
                return Ok(k);
            }
        }
        let cached = self.file_keys.lock().unwrap().normal.clone();
        if let Some(k) = cached.filter(good) {
            return Ok(k);
        }
        let k = self.file_key()?;
        self.file_keys.lock().unwrap().normal = Some(k.clone());
        Ok(k)
    }

    /// A link to open a stored file: `url` as documents and uploads have it (`/uploads/<id><ext>`)
    /// -> absolute, with the signature, valid for 6 to 12 hours (the server's key rolls over then).
    /// Anything else (an `https://` image) comes back unchanged, like `fileUrl` in src/api.ts.
    /// Fetches a key from the server when it has none that lasts a minute more (so it can fail
    /// offline); `locked` asks for the key that opens files on the user's locked pages, when
    /// unlocked.
    pub fn signed_file_url(&self, url: &str, locked: bool) -> Result<String, ApiError> {
        if !url.starts_with("/uploads/") {
            return Ok(url.to_string());
        }
        if upload_name(url).is_none() {
            return Ok(format!("{}{url}", self.base));
        }
        let key = self.usable_key(locked)?;
        Ok(format!("{}{}", self.base, sign_upload_path(url, &key)))
    }

    /// The bytes of a stored file, from its signed link. 401/403 mean no access (or a lapsed
    /// key: ask again), 404 that it is gone.
    pub fn download_file(&self, url: &str, locked: bool) -> Result<FileData, ApiError> {
        let link = self.signed_file_url(url, locked)?;
        let req = DownloadRequest { url: link };
        let tries = 3;
        let mut i = 0;
        let res = loop {
            match self.transport.download(&req) {
                Ok(r) if i + 1 < tries && RETRYABLE.contains(&r.status) => {}
                Ok(r) => break r,
                Err(e) if i + 1 >= tries => return Err(ApiError::Network(e)),
                Err(_) => {}
            }
            std::thread::sleep(Duration::from_millis(400 * 3u64.pow(i)));
            i += 1;
        };
        if !(200..300).contains(&res.status) {
            return Err(ApiError::Http {
                status: res.status,
                message: String::from_utf8_lossy(&res.body)
                    .chars()
                    .take(200)
                    .collect::<String>()
                    .trim()
                    .to_string(),
                code: None,
                request_id: None,
            });
        }
        let mime = res
            .content_type
            .as_deref()
            .and_then(|c| c.split(';').next())
            .map(|c| c.trim().to_ascii_lowercase())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| "application/octet-stream".into());
        Ok(FileData {
            bytes: res.body,
            mime,
        })
    }
}
