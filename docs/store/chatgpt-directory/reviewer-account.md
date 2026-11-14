# Reviewer account

OpenAI's reviewers sign in to Notivelo from ChatGPT with a dedicated test account. Their rules (https://developers.openai.com/plugins/deploy/submission, "Reviewer credentials", and the guidelines' "Testing and reviewer access"):

- A dedicated test account with sample data, not a real person's account, fully featured.
- It must work without MFA approval, email or SMS codes, magic links, or private-network access. No sign-up step for the reviewer.
- The email, password, login URL, workspace details and sign-in steps go into the dashboard's **Review details** form, never into the package. The package upload rejects `test_credentials` and `reviewer_instructions`.

Nothing in this repo holds the reviewer's email or password. Keep them in your password manager and type them only into the Review details form.

## 1. Create the account (Devon)

1. Pick an email address you control that is only for this, for example a new alias on notiveloapp.com. Do not reuse the App Store review account, so the two reviews can't interfere (OpenAI's reviewers will add pages and tasks).
2. Sign up at https://app.notiveloapp.com the normal way, with a long random password from your password manager.
3. Confirm the email address from the message Notivelo sends. Notivelo has no two-factor sign-in, so after this a reviewer needs only the email and password.

## 2. Fill it with sample content (Devon runs the script)

`scripts/seed-review-account.ts` signs in as that account through the public API and adds the sample content. It never creates accounts and never prints passwords, and it is safe to run twice (existing items are skipped by name).

It needs one more secret: a **locked-notes password** (6+ characters), used once to lock the sample private page. Make a new random one; the reviewer never needs it. If the account already has a locked-notes password, `LOCK_PASSWORD` can be left out.

PowerShell:

```powershell
$env:BASE_URL = "https://app.notiveloapp.com"
$env:REVIEW_EMAIL = "<reviewer email>"
$env:REVIEW_PASSWORD = "<reviewer password>"
$env:LOCK_PASSWORD = "<new random locked-notes password>"
npx tsx scripts/seed-review-account.ts
Remove-Item Env:REVIEW_PASSWORD, Env:LOCK_PASSWORD
```

bash:

```bash
BASE_URL=https://app.notiveloapp.com REVIEW_EMAIL='<reviewer email>' REVIEW_PASSWORD='<reviewer password>' \
  LOCK_PASSWORD='<new random locked-notes password>' npx tsx scripts/seed-review-account.ts
```

Leave out `SHARE_WITH_EMAIL` for this account.

What it adds, in the account's own workspace:

| Where | What | Used by |
|---|---|---|
| Projects > Planning | Kickoff meeting (attendees, agenda, notes, decisions, three action-item tasks) | P2 |
| Projects > Planning | Project brief (goal, scope, milestones table) | |
| Projects > Planning | Supplier shortlist (quotes table with "Harbor Print Co.", an "Open questions" box) | P1, P4, P5 |
| Projects > Design | Site structure (numbered outline, table, a task) | |
| Projects > Launch prep | Launch checklist (checklist) | P3 (section), N1 |
| Tasks | Eight tasks with due dates, priorities, tags; one repeating; "Book the photographer" is open | P5 |
| Personal (private notebook) | **Salary and bonus notes**, locked | N2 |

If the output ends with `Warning: "Salary and bonus notes" was NOT locked`, set `LOCK_PASSWORD` and run it again.

Tested locally on 13 Nov 2026 against a fresh server on port 4423 (`NODE_ENV=production`, temporary data folder, open sign-up, a throwaway local account): the first run created everything above and locked the page (the tree shows it as `[LOCKED]`); the second run printed "Everything already exists; nothing changed." It has **not** been run against production.

## 3. Check it yourself before submitting

1. Sign in at https://app.notiveloapp.com as the reviewer account and look at the Projects and Personal notebooks.
2. In ChatGPT (a separate ChatGPT account from your own is best), connect Notivelo with that account and run every case in review-cases.md.
3. Afterwards, tidy up what the cases added (the "Launch week plan" page, the flyers task, the extra bullet, re-open "Book the photographer") so the reviewers start from the same state. Disconnect ChatGPT in Settings > Connected apps.

Run the cases again just before submitting if the content has changed.

## 4. Review details form (paste, then fill the brackets)

- **Login URL:** https://app.notiveloapp.com (ChatGPT opens the Notivelo sign-in page when you connect)
- **Email / password:** [from your password manager]
- **Workspace / tenant:** the account's own workspace (named after the account, "[name]'s Space"); sample content is in the "Projects" notebook.
- **Sign-in instructions:**

```
1. In ChatGPT, add Notivelo and choose Connect. A Notivelo sign-in page opens.
2. Sign in with the email and password above. There is no second factor or emailed code.
3. On the "Allow ChatGPT to use your Notivelo account?" page, leave "edit" ticked and choose Allow.
4. Sample content is in the "Projects" notebook (Planning, Design, Launch prep). "Personal" holds a locked page used in negative case 2; it is meant to be invisible to ChatGPT.
5. For negative case 3 (read-only): in Notivelo go to Settings > Connected apps and disconnect ChatGPT, then connect again and untick "edit" on the Allow page.
Please do not change the account's password or delete the sample notebooks.
```
