<!--
TODO for the owner (this comment is not shown to users):
- This is a plain-English STARTING TEMPLATE, not legal advice. Have a lawyer review it before real outside users sign up and before store submission.
- Contact email and operator name default to support@devswartz.com and "devswartz.com" (src/pages/Legal.tsx). The server env vars LEGAL_CONTACT_EMAIL and LEGAL_OPERATOR_NAME override them; {{CONTACT_EMAIL}}, {{OPERATOR_NAME}} and {{APP_NAME}} below are filled from those.
- Check the retention periods and the features listed below still match what the app does, then update "Last updated".
- Edit this file freely: headings (#), paragraphs, lists (- or 1.), links [text](url), **bold**, *italic*. No HTML.
-->

# Privacy Policy

Last updated: 5 November 2026

{{APP_NAME}} is a notes and tasks app. It is run by {{OPERATOR_NAME}} ("we", "us"), who host it on their own server. This page explains what information the app keeps about you and what we do with it. We have tried to keep it short and plain.

## What we collect

- **Account details:** your name, your email address and a hashed version of your password. We never store your password itself.
- **Your content:** the notes, pages, tasks, comments, files and images you create or upload, and the workspaces and notebooks they live in.
- **Sign-in sessions:** a record of each device you are signed in on (a token and the device's browser or app name), so you can stay signed in and be signed out remotely.
- **Notification settings and push tokens:** if you turn on notifications in the mobile or desktop app, your device gives us a push token so we can send reminders to it.
- **Technical data:** your IP address and the time of each request. We use it to limit repeated sign-in attempts and to keep server logs. Each request gets a random request ID so we can trace a problem.

## What we do with it

- Run the app: show you your notes and tasks, sync them between your devices and share them with people you invite.
- Send you email (see below).
- Keep the service secure: rate limiting, blocking abuse and investigating faults.
- Fix bugs: see error reports below.

We do **not** show ads, we do **not** sell your data, and we do **not** share it with data brokers or advertisers.

## Email we send

We send email only for things you do or that happen in your account: workspace invitations, email address verification, password reset links, and task reminders and digests you have turned on. We send mail through an email delivery service (SMTP provider), which therefore sees your address and the message.

## Error reports and feedback

- **Error reports:** when something breaks in the app, it may send us the error details (message, where it happened, app version) together with your account ID, so we can find and fix the bug. It does not send the text of your notes on purpose.
- **Feedback:** if you use the feedback command in the app, your message and your account details are emailed to the people who run this server.

## Who can see your content

Content in a workspace is visible to the people in that workspace, based on their role. Private notebooks are visible only to you. The people who run the server can technically access the database and uploaded files, because they host them. We will only look at your content when needed to keep the service running, to deal with abuse, or if the law requires it.

## Who we share data with

- The hosting provider and email delivery service we use to run the app.
- Apple and Google, only to deliver push notifications to the mobile app.
- Authorities, if the law requires it.

Nothing else.

## How long we keep it

- Your account and content are kept until you delete them or delete your account.
- Sign-in sessions expire or are removed when you sign out or change your password.
- Server logs (IP addresses, request IDs, error details) are kept for a limited time, normally a few weeks, and are then deleted.
- Backups of the database may keep deleted data for a short while longer before they are overwritten.

## Deleting your data

You can delete your account yourself in **Settings → Delete account**. This deletes your private notebooks, tasks, files and sign-in sessions. Workspaces you own are handed to another member or deleted. Things you shared in other people's workspaces, such as comments or pages, stay in that workspace and are shown as written by a deleted user. You can also email us at {{CONTACT_EMAIL}} and ask for a copy of your data or for it to be deleted.

## Security

Passwords are hashed, connections use HTTPS, and sign-in attempts are rate limited. No system is perfectly secure, so please use a strong, unique password.

## Children

{{APP_NAME}} is not meant for children under 13 (or the minimum age in your country), and we do not knowingly collect their data.

## Changes

If we change this policy in a way that matters, we will update the date above and, for big changes, tell you in the app or by email.

## Contact

Questions or requests about your data: {{CONTACT_EMAIL}}.
