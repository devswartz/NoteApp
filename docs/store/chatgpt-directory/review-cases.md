# Review test cases

OpenAI asks for **exactly 5 positive and 3 negative** test cases, in the package under `extensions.com.openai.review` (they are in `package/plugin.json`; keep the two in step). Each must be run with the reviewer account before submitting (https://developers.openai.com/plugins/deploy/submission, "Review information").

All cases assume the reviewer account was filled by `scripts/seed-review-account.ts` (see reviewer-account.md): a "Projects" notebook (Planning, Design, Launch prep), pages Kickoff meeting, Project brief, Supplier shortlist, Site structure, Launch checklist, eight tasks, and a private "Personal" notebook with a **locked** page "Salary and bonus notes".

Connect with "Read and edit" allowed, except negative case 3. Run negative case 3 last.

Automated tests that back each case are named by file and test title; run them with `npm test` (or `npx tsx --test tests/mcp.test.ts tests/oauth.test.ts tests/locked-pages.test.ts`).

## Positive cases

### P1. Search

- **Prompt:** `Search my Notivelo notes for Harbor Print and tell me what they quoted.`
- **Tools:** `search_pages` (then usually `read_page`)
- **Expected:** finds the page "Supplier shortlist" (Projects > Planning) and answers: Harbor Print Co. quoted £420 with a 5-day lead time. Nothing is changed.
- **Tests:** tests/mcp.test.ts, "read tools: workspaces, sections, pages, search, read_page with box ids, tasks".

### P2. Read a page

- **Prompt:** `Open my Kickoff meeting page in Notivelo and summarise the decisions and the action items.`
- **Tools:** `search_pages`, `read_page`
- **Expected:** decisions: launch in six weeks; keep the existing logo and colours; photos before copy. Action items (tasks on the page): Rewrite the homepage copy, Share homepage mock-ups, Book the photographer, with their due dates. Nothing is changed.
- **Tests:** tests/mcp.test.ts, "read tools: ..." and "task notes: read_page shows them nested; ...".

### P3. Create a page

- **Prompt:** `Create a new Notivelo page called "Launch week plan" in my Launch prep section, with a short plan for Monday to Friday.`
- **Tools:** `list_workspaces`, `list_sections`, `create_page`
- **Expected:** a page "Launch week plan" appears at the end of Projects > Launch prep, with one text box holding a heading or list for each weekday. In Notivelo the page's activity says it was created through ChatGPT.
- **Tests:** tests/mcp.test.ts, "create_page: Markdown and HTML become sanitised boxes; scripts and images are dropped; activity says via the app".

### P4. Edit an existing box

- **Prompt:** `On my Notivelo "Supplier shortlist" page, add "Ask Brightline Press for a faster lead time" to the Open questions list.`
- **Tools:** `search_pages`, `read_page`, then `append_box` with that box's `box_id` (or `replace_box_content` on the same box)
- **Expected:** the Open questions box now has four bullets, the new one last; the table box is unchanged. If the page is open in Notivelo the change appears live. Version history has a version from before the change, and the activity says "through ChatGPT".
- **Tests:** tests/mcp.test.ts, "append_box and replace_box_content: live in an open editor, versioned, tasks kept, attributed".

### P5. Create and update tasks

- **Prompt:** `In Notivelo, add a task "Order launch flyers from Harbor Print Co." to the Supplier shortlist page, due next Friday, high priority. Then mark "Book the photographer" as done.`
- **Tools:** `search_pages`, `create_task`, `list_tasks`, `update_task`
- **Expected:** a new task on the Supplier shortlist page with that title, next Friday's date and high priority (2); "Book the photographer" is ticked (done). Both show in Notivelo's task views.
- **Tests:** tests/mcp.test.ts, "create_task and update_task: on a page (live), standalone and as a subtask; activity via the app".

## Negative cases

### N1. Delete a page (no delete tool)

- **Prompt:** `Delete my Notivelo page "Launch checklist".`
- **Why it should not act:** the connector has no delete tools on purpose; deleting is only possible in the Notivelo app, where it goes to the Trash.
- **Expected:** ChatGPT may look the page up (`search_pages`) but calls no write tool. It says it can't delete pages through Notivelo and suggests deleting it in the app. The page is still there.
- **Tests:** tests/mcp.test.ts, "the official MCP client connects, and tools/list has every tool with the right annotations" (asserts the exact tool list and that no tool name contains "delete").

### N2. Ask for a locked page

- **Prompt:** `Show me my Notivelo page "Salary and bonus notes".`
- **Why it should not act:** the page is locked. Locked pages, their titles and their tasks are invisible to connected apps, even while unlocked in the app.
- **Expected:** `search_pages` / `list_pages` return no such page. ChatGPT says it can't find it. No title, text or task from the page appears in the answer.
- **Tests:** tests/locked-pages.test.ts, "the AI connector never sees a locked page, its title or its tasks, even while unlocked".

### N3. Write with a read-only connection

- **Setup:** in Notivelo, Settings > Connected apps, disconnect ChatGPT. In ChatGPT, connect again and on the Notivelo consent page **untick** "edit" before Allow.
- **Prompt:** `Create a Notivelo page called "Test" in my Planning section.`
- **Why it should not act:** the user allowed reading only (`notes:read`), so a write needs `notes:write`.
- **Expected:** the `create_page` call is refused (HTTP 403, `insufficient_scope`, asking for `notes:read notes:write`). ChatGPT says it only has read access and may offer to reconnect with edit permission. No page is created. Afterwards, disconnect and reconnect with edit allowed.
- **Tests:** tests/mcp.test.ts, "scopes: a read-only token reads but a write tool is 403 insufficient_scope; a write-only token cannot read"; tests/oauth.test.ts, "scope downgrade: the user can allow read only, and refresh can narrow but never widen".

## Also covered by tests (not separate cases)

- OAuth sign-in, consent, tokens and refresh: tests/oauth.test.ts, "full flow: register → authorize → consent → token → refresh rotation → revoke → verify".
- ChatGPT's Client ID Metadata Document is accepted: tests/oauth.test.ts, "Client ID Metadata Documents: fetched, validated and cached".
- Disconnecting: tests/oauth.test.ts, "Settings → Connected apps: revoke ends every connection to that app, for that user only".
- Another user's notes stay invisible: tests/mcp.test.ts, "access: another user’s pages, sections, tasks and search results stay invisible; so do private notebooks".
