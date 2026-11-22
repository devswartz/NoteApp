//! Full-text search and comment threads in the Core API (docs/rewrite/status/core.md, "For
//! apple: search" and "For apple: comments"). Both go through today's server (server/routes/
//! search.ts, server/routes/comments.ts) and need the network: nothing is cached or queued, and
//! a `CoreError::Network` is returned as it is.

use crate::task_detail::{detail, TaskDetail};
use crate::{new_task_id, Core, CoreError};

/// A piece of a search snippet: plain text, or text the query matched.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SnippetRun {
    pub text: String,
    pub matched: bool,
}

const OPEN: char = '\u{ab}';
const CLOSE: char = '\u{bb}';

/// Split a server snippet into runs, the way the web does (`highlightSnippet` in
/// src/components/CommandPalette.tsx): an open/close marker pair is a matched run (markers
/// dropped), the rest is plain text; an open marker without its close stays as plain text.
/// Empty runs are left out.
#[uniffi::export]
pub fn parse_snippet(snippet: String) -> Vec<SnippetRun> {
    let mut runs = Vec::new();
    let mut plain = String::new();
    let mut rest = snippet.as_str();
    while let Some(open) = rest.find(OPEN) {
        let after = &rest[open + OPEN.len_utf8()..];
        // The web's /(«[^»]*»)/ takes the text up to the first close marker, so a second open
        // marker inside is part of the matched text.
        let Some(close) = after.find(CLOSE) else {
            break;
        };
        plain.push_str(&rest[..open]);
        if !plain.is_empty() {
            runs.push(SnippetRun {
                text: std::mem::take(&mut plain),
                matched: false,
            });
        }
        let text = &after[..close];
        if !text.is_empty() {
            runs.push(SnippetRun {
                text: text.to_string(),
                matched: true,
            });
        }
        rest = &after[close + CLOSE.len_utf8()..];
    }
    plain.push_str(rest);
    if !plain.is_empty() {
        runs.push(SnippetRun {
            text: plain,
            matched: false,
        });
    }
    runs
}

/// A page the search found.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct PageSearchHit {
    pub page_id: String,
    pub title: String,
    pub icon: Option<String>,
    /// The matching text with the matched terms marked; empty when only the title matched (and
    /// for a locked page, whose text is never searched).
    pub snippet: Vec<SnippetRun>,
    pub notebook_name: String,
    pub section_name: String,
    /// "Notebook > Section > Subsection" (with the server's separator), ready to show.
    pub path: String,
}

/// A task the search found.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TaskSearchHit {
    pub task: TaskDetail,
    /// Only when the task's description matched (the title is shown anyway); none otherwise.
    pub snippet: Option<Vec<SnippetRun>>,
}

/// What `Core::search` finds, best match first in each list.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SearchResults {
    pub pages: Vec<PageSearchHit>,
    pub tasks: Vec<TaskSearchHit>,
}

/// One comment of a thread.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ThreadComment {
    pub id: String,
    pub thread_id: String,
    /// A user id (`Core::members` has the names; may be `deleted-user`).
    pub author_id: String,
    /// Plain text, 1 to 10 000 characters.
    pub body: String,
    /// ISO instant, UTC.
    pub created_at: String,
    /// When the author last edited it (ISO, UTC), if they did.
    pub edited_at: Option<String>,
}

/// A comment thread on a selection of a page. Its anchor in the page is the `comment` mark whose
/// `thread_id` is `id` (`Mark::Comment`).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct CommentThread {
    pub id: String,
    pub page_id: String,
    pub workspace_id: String,
    /// The selected text when the thread was started (at most 500 characters).
    pub quote: String,
    pub created_by: String,
    pub created_at: String,
    pub resolved: bool,
    /// When and by whom it was resolved (user id); none while open.
    pub resolved_at: Option<String>,
    pub resolved_by: Option<String>,
    /// Oldest first; the first is the one that started the thread.
    pub comments: Vec<ThreadComment>,
}

fn thread(t: nv_api::CommentThread) -> CommentThread {
    CommentThread {
        resolved: t.resolved_at.is_some(),
        id: t.id,
        page_id: t.page_id,
        workspace_id: t.workspace_id,
        quote: t.quote,
        created_by: t.created_by,
        created_at: t.created_at,
        resolved_at: t.resolved_at,
        resolved_by: t.resolved_by,
        comments: t
            .comments
            .into_iter()
            .map(|c| ThreadComment {
                id: c.id,
                thread_id: c.thread_id,
                author_id: c.author_id,
                body: c.body,
                created_at: c.created_at,
                edited_at: c.edited_at,
            })
            .collect(),
    }
}

fn results(r: nv_api::SearchResult) -> SearchResults {
    SearchResults {
        pages: r
            .pages
            .into_iter()
            .map(|p| PageSearchHit {
                page_id: p.id,
                title: p.title,
                icon: p.icon,
                snippet: parse_snippet(p.snippet),
                notebook_name: p.notebook_name,
                section_name: p.section_name,
                path: p.path,
            })
            .collect(),
        tasks: r
            .tasks
            .into_iter()
            .map(|t| TaskSearchHit {
                task: detail(t.task),
                snippet: t.snippet.map(parse_snippet),
            })
            .collect(),
    }
}

/// A new comment thread id: a random UUID, which the server requires (and the page's `comment`
/// mark carries).
#[uniffi::export]
pub fn new_comment_thread_id() -> String {
    new_task_id()
}

#[uniffi::export]
impl Core {
    /// Search the workspace's pages (title and text) and tasks (title and description). Online
    /// only: no network gives `CoreError::Network`, and nothing is cached. The server prefix
    /// matches every word of `query` (so "plan" finds "planning"), stems, requires all words, and
    /// ranks title matches first. `limit` is per list, 1 to 50 (the server's default is 20). A
    /// blank query returns nothing without a request. Locked pages are found by title only, and
    /// tasks on locked pages are left out. The web asks after 150 ms of no typing.
    #[uniffi::method(default(limit = None))]
    pub fn search(
        &self,
        workspace_id: String,
        query: String,
        limit: Option<u32>,
    ) -> Result<SearchResults, CoreError> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(SearchResults {
                pages: vec![],
                tasks: vec![],
            });
        }
        Ok(results(self.api.search(&workspace_id, q, limit)?))
    }

    /// The page's comment threads, oldest first, resolved ones included. Needs the network.
    /// Locked pages answer 403 until unlocked.
    pub fn page_comments(&self, page_id: String) -> Result<Vec<CommentThread>, CoreError> {
        Ok(self
            .api
            .page_comments(&page_id)?
            .into_iter()
            .map(thread)
            .collect())
    }

    /// Start a thread on a page with its first comment (members and up; viewers get 403).
    /// `thread_id` is from `new_comment_thread_id()` and is also the id of the `comment` mark
    /// that anchors it: create the thread first, then mark the selection with this id. Calling
    /// again with the same id (a retry) returns the thread already made. `quote` is the selected
    /// text (cut to 500 characters by the server).
    pub fn add_comment_thread(
        &self,
        page_id: String,
        thread_id: String,
        quote: String,
        body: String,
    ) -> Result<CommentThread, CoreError> {
        Ok(thread(
            self.api
                .add_comment_thread(&page_id, &thread_id, &quote, &body)?,
        ))
    }

    /// Reply to a thread; replying to a resolved thread reopens it.
    pub fn reply_to_comment_thread(
        &self,
        thread_id: String,
        body: String,
    ) -> Result<CommentThread, CoreError> {
        Ok(thread(self.api.reply_to_thread(&thread_id, &body)?))
    }

    /// Resolve a thread (any member can; viewers get 403).
    pub fn resolve_comment_thread(&self, thread_id: String) -> Result<CommentThread, CoreError> {
        Ok(thread(self.api.set_thread_resolved(&thread_id, true)?))
    }

    /// Reopen a resolved thread.
    pub fn reopen_comment_thread(&self, thread_id: String) -> Result<CommentThread, CoreError> {
        Ok(thread(self.api.set_thread_resolved(&thread_id, false)?))
    }

    /// Edit your own comment (403 for someone else's); answers with its thread.
    pub fn edit_comment(
        &self,
        comment_id: String,
        body: String,
    ) -> Result<CommentThread, CoreError> {
        Ok(thread(self.api.edit_comment(&comment_id, &body)?))
    }

    /// Delete one comment (its author, or a workspace admin). Deleting a thread's last comment
    /// deletes the thread: the answer says whether it did; if so, remove the thread's `comment`
    /// mark from the page, as the web does.
    pub fn delete_comment(&self, comment_id: String) -> Result<bool, CoreError> {
        Ok(self.api.delete_comment(&comment_id)?)
    }

    /// Delete a whole thread with its comments (its starter, or a workspace admin).
    pub fn delete_comment_thread(&self, thread_id: String) -> Result<(), CoreError> {
        Ok(self.api.delete_comment_thread(&thread_id)?)
    }
}
