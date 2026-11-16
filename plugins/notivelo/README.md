# Notivelo for Claude

Connects Claude to your [Notivelo](https://notiveloapp.com) account, so you can find, read and write your notes and tasks from a conversation.

## What you can ask Claude to do

- **Find notes:** search page titles and text across your workspaces, or browse your notebooks, sections and pages.
- **Read a page:** get a page's text box by box, with the tasks on it.
- **Write notes:** create a page in a section, add text to a page or to one text box, or rewrite one text box. Headings, lists, tables and `- [ ]` to-do lines become Notivelo formatting and real tasks.
- **Manage tasks:** list open or completed tasks, create a task (on a page, in a workspace, or as a subtask), and tick, reopen, rename, reschedule, reprioritise or reassign it.

Example prompts:

- "Search my Notivelo notes for last week's meeting and summarise the decisions."
- "Turn the action items from this chat into Notivelo tasks with due dates."
- "Create a Notivelo page in my Planning section with a project plan for this idea."

## Install (Claude Code)

```bash
claude plugin marketplace add devswartz/NoteApp
claude plugin install notivelo@notivelo
```

Then, in a Claude Code session, run `/mcp`, choose **notivelo** and sign in. A Notivelo page opens in your browser. Sign in there and choose what Claude may do: read only, or read and edit.

## You stay in control

- Claude acts as you and sees only what you can see in Notivelo.
- It cannot delete anything: no pages, sections, notebooks or tasks.
- Locked pages are never shown to Claude, not even their titles.
- Every change shows in the page's activity under the connected app's name, and the page keeps a version from before the change, so you can restore it from Version history.
- You can disconnect at any time in Notivelo, under Settings > Connected apps.

## Limitations

- Images and file attachments are not read or written.
- Very long pages are cut off, with a notice saying so.
- There are limits on how much text can be written at once and how many changes can be made in a short time.
- You need a Notivelo account. You can create one at [app.notiveloapp.com](https://app.notiveloapp.com).

## Support

- Help: https://app.notiveloapp.com/support
- Email: support@notiveloapp.com
- Privacy policy: https://app.notiveloapp.com/privacy
- Terms: https://app.notiveloapp.com/terms
