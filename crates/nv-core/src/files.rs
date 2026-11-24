//! Images and attachments in the Core API: upload a file, get a link to show or open it, read
//! its bytes. Each call mirrors a route of today's server (`server/routes/files.ts`; the web's
//! side is `src/editor/upload.ts` and `fileUrl` in `src/api.ts`).
//!
//! **Online only**, like the tree calls: nothing is queued or kept on the device; offline they
//! throw `CoreError::Network`. The server has no route to delete a file.
//!
//! Documents keep a file's plain path (`/uploads/<id><ext>`, what `upload_file` answers in `url`
//! and what the editor's image and file nodes hold in `src` / `url`). To show or open it, turn
//! the path into a signed link with `file_url`, or read its bytes with `download_file`.

use nv_api as api;

use crate::{Core, CoreError};

/// A file the server stored.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct UploadedFile {
    /// The file's id (what `file_info` takes).
    pub id: String,
    /// The stored path, `/uploads/<id><ext>`: what documents keep (the editor's `src` and `url`).
    pub url: String,
    /// The original file name (up to 200 characters).
    pub name: String,
    /// Decided by the server from the extension: `image/png`, `application/pdf`, ...,
    /// `application/octet-stream` for an extension it doesn't know.
    pub mime: String,
    /// Size in bytes.
    pub size: u64,
}

/// A file's bytes with the type it was served as.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FileContents {
    pub bytes: Vec<u8>,
    /// `image/png`, `application/pdf`, ... (`application/octet-stream` if unknown).
    pub mime: String,
}

fn uploaded(f: api::UploadedFile) -> UploadedFile {
    UploadedFile {
        id: f.id,
        url: f.url,
        name: f.name,
        mime: f.mime,
        size: f.size,
    }
}

#[uniffi::export]
impl Core {
    /// Upload a file into a workspace, onto a page when `page_id` is given (needs edit access to
    /// it; a locked page only while unlocked). Up to 25 MB: a bigger one is refused before
    /// anything is sent as `CoreError::Server` with status 413 and code `file_too_large`
    /// (message: "“name” is larger than 25 MB"); an empty one the same way with status 400 and
    /// code `file_empty`. Other refusals are the server's: 403 (view-only), 404 (no such page).
    /// Take `filename` from the picked file (an empty one becomes "file"); the server keeps
    /// only extensions on its allow-list (images, PDF, Office, text, audio, video, archives)
    /// and reports `mime` from it, never from the bytes. Blocking and up to three minutes on a
    /// slow link: call it off the main thread.
    pub fn upload_file(
        &self,
        workspace_id: String,
        page_id: Option<String>,
        filename: String,
        data: Vec<u8>,
    ) -> Result<UploadedFile, CoreError> {
        Ok(uploaded(self.api.upload_file(
            &workspace_id,
            page_id.as_deref(),
            &filename,
            &data,
        )?))
    }

    /// A file's metadata. 404 when it doesn't exist or the user may not see it.
    pub fn file_info(&self, file_id: String) -> Result<UploadedFile, CoreError> {
        Ok(uploaded(self.api.file_info(&file_id)?))
    }

    /// A link to show or open a stored file: the path a document or `upload_file` holds
    /// (`/uploads/<id><ext>`) becomes an absolute URL with a signature (the server checks it and
    /// that the user may still see the file). It works without any header, so an image view or
    /// a share sheet can load it, and stays valid 6 to 12 hours: ask again when it is used later
    /// (do not store it in a document). Anything that isn't an upload path (an `https://` image)
    /// comes back unchanged. The first call after sign-in (and one every few hours) asks the
    /// server for a signing key, so it can throw `CoreError::Network` offline and should be
    /// called off the main thread; the rest are instant. Files on a locked page open only while
    /// the notes are unlocked; for an unlocked sign-in the key that includes them is used.
    pub fn file_url(&self, url: String) -> Result<String, CoreError> {
        Ok(self.api.signed_file_url(&url, self.maybe_unlocked())?)
    }

    /// A stored file's bytes (up to about 25 MB) and type, for a share sheet or a quick look.
    /// `url` is as for `file_url`. 403 when the user has no access (a locked page that is locked,
    /// or access taken away), 404 when the file is gone. Blocking: off the main thread.
    pub fn download_file(&self, url: String) -> Result<FileContents, CoreError> {
        let f = self.api.download_file(&url, self.maybe_unlocked())?;
        Ok(FileContents {
            bytes: f.bytes,
            mime: f.mime,
        })
    }
}
