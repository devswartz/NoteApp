<!--
Owner checklist (this comment is not shown to users):
- [ ] Have a lawyer review this before outside users sign up and before App Store submission. It is a plain-English draft, not legal advice.
- [ ] Confirm the contact inbox exists and is read: {{CONTACT_EMAIL}} defaults to support@devswartz.com and {{OPERATOR_NAME}} to "devswartz.com" (src/pages/Legal.tsx); LEGAL_CONTACT_EMAIL and LEGAL_OPERATOR_NAME on the server override them.
- [ ] Re-check this page, and docs/app-store-privacy.md, whenever a feature changes what is stored or sent (new third party, new upload type, analytics, sharing changes), then update "Last updated".
- Edit freely: headings (#), paragraphs, lists (- or 1.), links [text](url), **bold**, *italic*. No HTML.
-->

# Privacy Policy

Last updated: 12 November 2026

{{APP_NAME}} is a notes and tasks app. It is run by {{OPERATOR_NAME}} ("we", "us"), who host it on their own server. This page explains what information the app keeps about you, where it goes and what we do with it. We have tried to keep it short and plain.

## The short version

- Your account and your notes are stored on our server so they can sync between your devices and be shared with the people you choose.
- We do **not** show ads, we do **not** track you across other apps or websites, and we do **not** sell or rent your data to anyone.
- The app has no analytics or advertising tools built in.

## What we keep about you

- **Account details:** your name, your email address, a colour used for your initials in the app, and a hashed version of your password (we never store the password itself). We also note when your account was created and when you confirmed your email address.
- **Your content:** the workspaces, notebooks, sections, pages, tasks, comments, tags, teams, saved task views and templates you create, and the files and images you upload.
- **Version history:** earlier versions of each page, with who last edited it, so a page can be restored.
- **Activity and notifications:** a record of who changed what in a workspace (for example "Sam completed a task"), and the in-app notifications you receive, such as mentions, replies and task assignments.
- **Sign-in sessions:** a record of each device you are signed in on, so you can stay signed in. We store a scrambled (hashed) version of the session token, when it was created and expires, and the name your browser or app reports about itself (its "user agent").
- **Reminder and notification settings:** your time zone, reminder times, quiet hours, and whether email reminders and the daily digest are on.
- **Push notification addresses:** if you allow notifications, your browser or device gives us an address (a push subscription or device token) so we can send reminders to it.
- **Calendar feed:** if you turn on the calendar feed, we keep a scrambled version of its private link.

## What we do not keep

- We do not keep your IP address in our database or our logs. We hold it briefly in memory to limit repeated sign-in attempts and other abuse, and that memory is cleared when the server restarts.
- We do not collect your location, contacts, browsing history or advertising identifiers.
- Search terms are used to answer your search and are not stored.

## Sharing and who can see your content

- **Workspaces:** content in a workspace is visible to its members according to their role. Members can see each other's names, email addresses and colours. Private notebooks are visible only to you and the people you share them with.
- **Shared pages:** you can share a single page with someone, including someone outside your workspace, and let them view it or edit it. They see that page only, not the rest of the workspace. Inviting someone by email sends them an invitation link.
- **What people on a shared page see:** everyone who can open a shared page sees the names and colours of the others who can open it, for example on avatars and while editing together. People who manage a page's sharing also see the email addresses of those it is shared with.
- **Tasks on shared pages:** people with edit access can create, complete, edit and delete the tasks on that page, and can assign them to anyone who can open the page. A task assigned to you appears in your own task list and can trigger reminders to you, even if you are not a member of that workspace.
- **Edits are kept:** changes made by anyone on a page, including people outside the workspace, are kept in that page's version history.
- **Removing a share:** when a page stops being shared with someone, they lose access to it and are unassigned from its tasks.
- **Workspace export:** workspace owners and admins can download a copy of a whole workspace, which includes content written by its members.
- **Export my data:** the copy you can download of your own data (see below) contains only what you can see in the app. It can include pages and comments written by others in your workspaces and on pages shared with you.
- **Us:** the people who run the server can technically access the database and uploaded files, because they host them. We will only look at your content when needed to keep the service running, to deal with abuse, or if the law requires it.

**Uploaded files and images** open only for people who can open the page or workspace they belong to, including people a page is shared with. The app shows them through links that are signed for you and stop working after at most 12 hours. If you copy such a link, it opens only that one file, only until it expires, and only while you still have access. An older or copied file address opened in a browser asks you to sign in first, and then checks that you may see the file.

## What we do with it

- Run the app: show you your notes and tasks, sync them between your devices and share them with the people you choose.
- Send you the email and notifications described below.
- Keep the service secure: rate limiting, blocking abuse and investigating faults.
- Fix bugs, using the error reports described below.

We use your data only to provide {{APP_NAME}} to you. We do not use it for advertising, profiling or tracking, and we do not sell it.

## Email we send

We send email only for things you do or that happen in your account: email address confirmation, password reset links, workspace and page invitations, task reminders and the daily digest if you have turned them on. Mail is sent through Amazon Web Services' email service (Amazon SES), which therefore handles your email address and the message, including task titles in reminders.

## Notifications

- **Push notifications:** reminders and notifications sent to your phone, computer or browser go through the push service of your device or browser: Apple (iPhone, iPad and Safari), Google (Android and Chrome) or your browser's maker. The notification text, such as a task title, passes through that service.
- **Calendar feed:** if you turn it on, your tasks with due dates are available at a private link that your calendar app reads. Anyone with that link can see those tasks, so you can reset the link at any time.

## Error reports and feedback

- **Error reports:** when something breaks in the app, it sends us the error details: the error message and where in the code it happened, the app version, the page address without any query, your browser or device name, and your account ID if you are signed in. It does not read or send your notes. Reports are written to our server log and not stored in the database.
- **Feedback:** if you use "Send feedback" in the app, your message is emailed to the people who run this server, together with your name, email address, account ID, app version, platform, browser or device name, and the page you were on. A short record of it (without the message, if the email was delivered) is written to our server log.

## On your device

Some things stay only on your device and are never sent to us:

- **App lock:** if you turn on Face ID, Touch ID or fingerprint unlock in the mobile app, the check is done entirely by your device. We never receive your fingerprint, face data or any biometric information; the app only learns whether the unlock succeeded.
- **Offline copy:** the app keeps a copy of your recent pages, tasks and workspace lists on your device so they open quickly and work offline. Your sign-in token is kept in your device's secure storage (in the mobile and desktop apps) or your browser's storage (on the web). These are removed when you sign out.
- **Preferences:** settings such as the theme, which parts of the notes tree are open and the last workspace you used are kept in your browser or app storage.
- **Share to {{APP_NAME}} and the widget (iOS):** text or a link you share to the app from another app is held on your device until the app opens and saves it to your account as a task or note. The Today widget shows tasks from a copy kept on your device; with app lock on, it shows only a count.
- **Reminders on desktop and mobile** may be scheduled as local notifications by your device.

We do not use cookies for sign-in or tracking. The only cookie we set is a short-lived security cookie during a OneNote import (see below), which expires within 10 minutes.

## Third parties

We do not share your data with anyone except the services we need to run the app:

- **Cloudflare**, which sits in front of our server and carries all traffic to and from it as a proxy, and so sees your IP address and the requests you make. Cloudflare handles that traffic under its own [privacy policy](https://www.cloudflare.com/privacypolicy/).
- **Amazon Web Services (Amazon SES)**, which delivers our email.
- **Apple, Google and your browser's push service**, only to deliver push notifications.
- **Microsoft**, only if you choose to import from OneNote. You sign in with Microsoft directly and allow read access to your OneNote notebooks. We use that access only for the import; it is held in memory for at most an hour, never stored, and discarded when the import finishes.
- **GitHub**, only for the desktop app: it checks GitHub for updates and downloads them from there, so GitHub sees your IP address and the app version. No account information is sent.
- **Authorities**, if the law requires it.

Nothing else.

## How long we keep it

- Your account and content are kept until you delete them or delete your account.
- Deleting a page, notebook or task removes it straight away; there is no recycle bin.
- Page version history keeps every version from the last 24 hours, then one an hour for a week, then one a day, up to 200 versions per page. It is deleted with the page.
- Sign-in sessions last up to 30 days unless used, and are removed when they expire or you sign out.
- Accounts whose email address is never confirmed are deleted automatically after 7 days.
- Email confirmation and other one-time links expire and are then deleted. Records of which reminders were sent are deleted after 30 days.
- Server logs (including error reports, which carry your account ID, feedback records and request IDs) are kept only briefly, normally less than a day, and never copied elsewhere.
- **Backups:** the database and uploaded files are backed up every day. We keep about 14 recent daily copies and 8 weekly copies. The whole server is also backed up every night, keeping up to 7 daily, 4 weekly and 3 monthly copies. Backups stay on our own hardware in the same place as the server, never with an outside storage provider, and are used only to restore the service after a failure. This means deleted data, including deleted accounts, can remain in backups for up to about 3 months before it ages out.

## Deleting your data

You can delete your account yourself in **Settings → Profile → Delete account**. This deletes your profile, your private notebooks and their files, your private tasks, your sign-in sessions, push addresses, reminder settings, calendar feed and the page shares you hold. Workspaces you own are handed to another owner or admin, or deleted if there is none. Things you created in shared places, such as pages, comments and tasks in a workspace, stay there and are shown as written by a deleted user; tasks assigned to you become unassigned.

Deleted data can remain in backups for up to about 3 months (see "How long we keep it").

You can also email us at {{CONTACT_EMAIL}} to ask for a copy of your data, to have it corrected, or to have it deleted.

## Getting a copy of your data

Anyone signed in can download their own data from **Settings → Profile → Export my data**. You get a zip file with:

- your account profile and the workspaces you belong to,
- every page you can open, in each workspace, as Markdown files, with the files you uploaded,
- the tasks you created or that are assigned to you,
- the comments you wrote,
- your notification settings (without the private push addresses and tokens).

It contains only what you can see in the app today: nothing from other people's private notebooks or from workspaces you are not in. Pages shared with you on their own come without the names of their workspace or notebook. To protect the server, you can export a few times a day.

Workspace owners and admins can also export a whole workspace as a zip file. You can always ask us for a copy of your data at {{CONTACT_EMAIL}}.

## Security

Passwords are hashed, connections use HTTPS, sign-in attempts are rate limited, session tokens are stored only in hashed form and uploaded files are only served through signed, expiring links to people who may see them. No system is perfectly secure, so please use a strong, unique password.

## Children

{{APP_NAME}} is not meant for children under 13 (or the minimum age in your country), and we do not knowingly collect their data.

## Changes

If we change this policy in a way that matters, we will update the date above and, for big changes, tell you in the app or by email.

## Contact

Questions or requests about your data: {{CONTACT_EMAIL}}.
