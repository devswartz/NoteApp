//! Version history in the Core API (docs/rewrite/status/core.md, "For apple: version history"):
//! list a page's saved versions, fetch one's document to preview, and restore one.
//!
//! **The server has no restore route.** The web restores in the client
//! (`src/editor/VersionHistory.tsx`): it asks the server to snapshot the current state as a
//! "before restore" version, then replaces the content of the **live document** with a copy of
//! the version's, in one Yjs transaction, which every open copy of the page receives like any
//! edit. `restore_version` does exactly that on an open `LivePage`
//! (`nv_model::restore::replace_page_content`, the Rust form of `replacePageContent`).
//!
//! What that means for an open page, and for the offline queue:
//! - The restore is **one local edit** on the page's document. It goes out like typing, behind
//!   any edit still waiting to be sent, and it is kept in the outbox until the server confirms
//!   it, so a restore made while the connection drops is sent on reconnect.
//! - Everyone else on the page converges on the restored content (they receive the update), and
//!   nothing can bring the old content back: the restore *deletes* the old items and inserts new
//!   ones, and a deleted item stays deleted in every merge, however old the copy that is merged
//!   (a stored page, an earlier queued edit). Edits made by others at the same moment into text
//!   the restore deleted are lost with it, as with any delete.
//! - The snapshot and the version fetch need the network, so **a restore needs a connection**:
//!   offline, `restore_version` throws `Network` and changes nothing.

use std::sync::Arc;
use std::time::{Duration, Instant};

use nv_api as api;

use crate::{new_box_id, Core, CoreError, LivePage};

/// One saved version of a page.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageVersion {
    pub id: String,
    /// The page's title when the version was saved.
    pub title: String,
    /// User id of who last edited the content, if known (`workspace_people`/`members` name them).
    pub author_id: Option<String>,
    /// "auto" (saved while the page was edited), "manual" (saved by someone, or before a
    /// conversion) or "restore" (the state just before a restore: "before restore" in the web).
    pub reason: String,
    /// When the content was last edited before this version was saved (ISO instant): the time
    /// the web's list shows.
    pub at: String,
    /// When the version was saved (ISO instant).
    pub created_at: String,
}

/// A version with its document.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageVersionDocument {
    pub version: PageVersion,
    /// The page as it was, a Yjs update: `read_page`, `page_content` and `page_markdown` read it.
    pub document: Vec<u8>,
}

fn version(v: api::PageVersion) -> PageVersion {
    PageVersion {
        id: v.id,
        title: v.title,
        author_id: v.author_id,
        reason: v.reason,
        at: v.at,
        created_at: v.created_at,
    }
}

#[uniffi::export]
impl Core {
    /// The page's saved versions, newest first. The server first takes a snapshot of the
    /// current state when one is due (nothing changed since the last: none). Locked pages: only
    /// while their owner has them unlocked. Not stored on the device.
    pub fn page_versions(&self, page_id: String) -> Result<Vec<PageVersion>, CoreError> {
        Ok(self
            .api
            .page_versions(&page_id)?
            .into_iter()
            .map(version)
            .collect())
    }

    /// A version and its document, to preview with `read_page` / `page_content`. Not stored on
    /// the device (and so never a locked page's).
    pub fn page_version(
        &self,
        page_id: String,
        version_id: String,
    ) -> Result<PageVersionDocument, CoreError> {
        let (v, document) = self.api.page_version(&page_id, &version_id)?;
        Ok(PageVersionDocument {
            version: version(v),
            document,
        })
    }

    /// Restore a version into an open page: save the page's current state as a "before restore"
    /// version (so the restore can itself be undone by restoring that one), then replace the
    /// page's content with the version's, as one edit that goes out to everyone. Needs edit
    /// access (403 for a viewer, before anything is changed) and a connection. `page` must be
    /// the page the version belongs to, opened with `open_live_page`/`open_page` on this core.
    ///
    /// Waits up to 3 s for edits not yet sent to reach the server first, so the "before restore"
    /// version includes them. Answers the id of the "before restore" version (none when the page
    /// was empty). Older single-column versions restore as one wide box.
    pub fn restore_version(
        &self,
        page: Arc<LivePage>,
        version_id: String,
    ) -> Result<Option<String>, CoreError> {
        if page.is_closed() {
            return Err(CoreError::Network {
                message: "the page is closed".into(),
            });
        }
        let page_id = page.page_id();
        let (_, document) = self.api.page_version(&page_id, &version_id)?;
        let source = nv_model::doc_from_update(&document)?;
        // Edits still waiting to be sent: give them a moment, so the snapshot has them.
        let until = Instant::now() + Duration::from_secs(3);
        while page.unsent_updates() > 0 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        let before = self.api.snapshot_page(&page_id, "restore")?;
        if page.is_closed() {
            return Err(CoreError::Network {
                message: "the page is closed".into(),
            });
        }
        nv_model::restore::replace_page_content(page.doc(), &source, &mut new_box_id);
        Ok(before)
    }
}
