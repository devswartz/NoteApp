# Demo video script (60 to 120 seconds)

OpenAI asks for a recording that "demonstrates the test cases and functionality", at a link reviewers can open (`demo_recording_url` in the package, see checklist.md). OpenAI gives no length or format rules; this script aims for about 100 seconds.

## Setup

- Record in a browser at 1920 x 1080 (or 1440 x 900), zoom 110 to 125% so text is readable. Two windows side by side, or switch tabs: **ChatGPT** on the left, **Notivelo** (https://app.notiveloapp.com, signed in as the reviewer account) on the right.
- Use the reviewer account after running the seed script, so the content matches review-cases.md. No real notes, names or email addresses on screen; hide the bookmarks bar and other tabs.
- Start with Notivelo **not** connected in ChatGPT (disconnect in Settings > Connected apps first).
- No voice-over needed. Optional captions are given per shot. Cut out waiting time while ChatGPT thinks, but don't cut inside a tool call's result.
- Expand ChatGPT's tool-call details where it shows them, so the tool names are visible.
- Upload as an unlisted video (YouTube unlisted, or a shared Google Drive / Loom link that opens without signing in) and check the link in a private window.

## Shots

| # | Time | On screen | Do / type | Caption |
|---|---|---|---|---|
| 1 | 0:00-0:05 | Notivelo, Projects notebook open on "Supplier shortlist". | Nothing, just show it. | Notivelo: notes and tasks |
| 2 | 0:05-0:20 | ChatGPT: add Notivelo, choose Connect. Notivelo sign-in page, then "Allow ChatGPT to use your Notivelo account?" with the read and edit permissions listed. | Sign in (password field masked; cut while typing it), leave edit ticked, Allow. Back in ChatGPT, connected. | Sign in and choose what ChatGPT may do |
| 3 | 0:20-0:32 | ChatGPT. | Type: `Search my Notivelo notes for Harbor Print and tell me what they quoted.` Show `search_pages` and the answer (£420, 5 days). | Search your notes |
| 4 | 0:32-0:45 | ChatGPT. | Type: `Open my Kickoff meeting page in Notivelo and summarise the decisions and the action items.` Show `read_page` and the summary. | Read a page |
| 5 | 0:45-1:02 | Split: ChatGPT left, Notivelo right with "Supplier shortlist" **open**. | Type: `On my Notivelo "Supplier shortlist" page, add "Ask Brightline Press for a faster lead time" to the Open questions list.` Keep Notivelo visible: the new bullet appears live. Then open the page's activity or Version history briefly to show "through ChatGPT" / the earlier version. | Edits show up live, and can be undone |
| 6 | 1:02-1:20 | ChatGPT, then Notivelo task view. | Type: `In Notivelo, add a task "Order launch flyers from Harbor Print Co." to the Supplier shortlist page, due next Friday, high priority. Then mark "Book the photographer" as done.` Show `create_task` and `update_task`. Switch to Notivelo: the new task on the page, and "Book the photographer" ticked (Tasks > Completed or on the Kickoff meeting page). | Create and complete tasks |
| 7 | 1:20-1:32 | ChatGPT. | Type: `Delete my Notivelo page "Launch checklist".` ChatGPT explains it can't delete pages through Notivelo. Switch to Notivelo: "Launch checklist" is still in Launch prep. | It can't delete anything |
| 8 | 1:32-1:40 | ChatGPT. | Optional (cut if over time): `Show me my Notivelo page "Salary and bonus notes".` ChatGPT can't find it. Notivelo sidebar shows the page with its lock. | Locked pages stay private |
| 9 | 1:40-1:45 | Notivelo, Settings > Connected apps, with ChatGPT listed and the Disconnect button. | Hover Disconnect (don't need to click). | Disconnect any time |

Total: about 1:45. If it runs long, drop shot 8 (it is covered by negative case 2) or shorten shot 2.

## After recording

- Watch it once at full screen: the prompts, the tool names and the Notivelo changes must be readable.
- Tidy the reviewer account afterwards (see reviewer-account.md, step 3).
- Put the link in `package/plugin.json` as `extensions.com.openai.review.demo_recording_url`, then build the ZIP (checklist.md).
