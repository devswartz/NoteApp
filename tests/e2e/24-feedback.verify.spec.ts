// "Send feedback" from the command palette, against the `verify-email` server (see playwright.config.ts): no SMTP, so the
// admin mail lands in the outbox, readable through the test-only GET /api/__test/outbox hook (E2E_TEST_HOOKS=1).
// That server runs with ADMIN_EMAILS=feedback-admin@e2e.test, which is where feedback is delivered.
import { expect, test, type APIRequestContext } from '@playwright/test';
import { PASSWORD, signInContext, tasksUrl, uniqueEmail, type TestUser } from './helpers.ts';

const ADMIN = 'feedback-admin@e2e.test';

interface Mail {
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}
const adminMail = async (request: APIRequestContext): Promise<Mail[]> => {
  const res = await request.get(`/api/__test/outbox?to=${encodeURIComponent(ADMIN)}`);
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as Mail[]).filter((m) => m.subject.startsWith('Feedback from '));
};

/** A verified user (this server requires verification, so confirm through the emailed link's token). */
async function verifiedUser(request: APIRequestContext, name: string): Promise<TestUser> {
  // The very first account on a server is auto-verified as a bootstrap account; make sure it isn't ours.
  await request.post('/api/auth/register', { data: { name: 'Bootstrap', email: uniqueEmail('bootstrap'), password: PASSWORD } });
  const email = uniqueEmail('feedback');
  const reg = await request.post('/api/auth/register', { data: { name, email, password: PASSWORD } });
  expect(reg.ok(), await reg.text()).toBe(true);
  const s = (await reg.json()) as { accessToken: string; refreshToken: string; user: { id: string } };
  if (!s.user || (s as unknown as { user: { emailVerified: boolean } }).user.emailVerified === false) {
    let token = '';
    await expect
      .poll(async () => {
        const r = await request.get(`/api/__test/outbox?to=${encodeURIComponent(email)}`);
        const m = ((await r.json()) as { text: string }[]).find((x) => /verify-email\?token=/.test(x.text));
        token = m ? /verify-email\?token=([\w-]+)/.exec(m.text)![1]! : '';
        return token;
      })
      .not.toBe('');
    const v = await request.post('/api/auth/verify-email', { data: { token } });
    expect(v.ok(), await v.text()).toBe(true);
  }
  const ws = await request.get('/api/workspaces', { headers: { authorization: `Bearer ${s.accessToken}` } });
  const workspaces = (await ws.json()) as { id: string }[];
  return { id: s.user.id, name, email, token: s.accessToken, refreshToken: s.refreshToken, wsId: workspaces[0]!.id };
}

test('palette → Send feedback → toast, and the admin gets the mail with Reply-To', async ({ page, context, request }) => {
  const user = await verifiedUser(request, 'Fay Feedback');
  await signInContext(context, user);
  await page.goto(`${tasksUrl(user.wsId, 'today')}?secret=abc#frag`);
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search' });
  await palette.getByPlaceholder(/Search pages and tasks/).fill('feedback');
  await expect(palette.locator('.palette-label', { hasText: 'Send feedback' })).toBeVisible();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('goes to the Notivelo team');
  const send = dialog.getByRole('button', { name: 'Send' });
  await expect(send).toBeDisabled(); // a message is required
  const message = `The sidebar is great <script>x</script> ${Date.now()}`;
  await dialog.getByLabel("What's on your mind?").fill(message);
  await expect(dialog).toContainText(`${message.length} / 4000`);
  await send.click();

  await expect(page.getByText('Thanks, your feedback was sent.')).toBeVisible();
  await expect(dialog).toHaveCount(0);

  await expect.poll(async () => (await adminMail(request)).some((m) => m.text.includes(message))).toBe(true);
  const mail = (await adminMail(request)).find((m) => m.text.includes(message))!;
  expect(mail.subject).toBe('Feedback from Fay Feedback on Notivelo');
  expect(mail.replyTo).toBe(user.email);
  expect(mail.text).toContain(user.email);
  expect(mail.text).toContain(user.id);
  expect(mail.text).toContain(`Page: /w/${user.wsId}/tasks/today\n`); // path only: no query or hash
  expect(mail.text).not.toContain('secret=abc');
  expect(mail.text).toContain('Platform: web');
  expect(mail.html).toContain('&lt;script&gt;x&lt;/script&gt;');
});

test('a failed send keeps the draft and shows an error; Cancel closes', async ({ page, context, request }) => {
  const user = await verifiedUser(request, 'Dana Draft');
  await signInContext(context, user);
  await page.goto(tasksUrl(user.wsId, 'today'));
  await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();

  await page.route('**/api/feedback', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong' }) }));
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('dialog', { name: 'Search' }).getByPlaceholder(/Search pages and tasks/).fill('send feedback');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  await dialog.getByLabel("What's on your mind?").fill('My draft survives');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong' })).toBeVisible();
  await expect(dialog.getByLabel("What's on your mind?")).toHaveValue('My draft survives');

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  // Also reachable from the "?" help overlay.
  await page.keyboard.press('?');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).getByRole('button', { name: 'Send feedback' }).click();
  await expect(page.getByRole('dialog', { name: 'Send feedback' }).getByLabel("What's on your mind?")).toHaveValue('My draft survives');
});
