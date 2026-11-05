// "Send feedback": a small dialog that emails the admins (POST /api/feedback, see server/routes/feedback.ts).
// Open it from anywhere with openFeedback(); <FeedbackHost /> is mounted once in the app shell.
// The draft survives a failed send and closing the dialog; it is cleared only after a successful send.
import { useState } from 'react';
import { create } from 'zustand';
import { post } from '../../api.ts';
import { errorToast, toast } from '../../store.ts';
import { detectPlatform } from '../../platform/index.ts';
import { APP_NAME } from '../../../shared/config.ts';
import { Button, Dialog } from '../ui.tsx';

export const FEEDBACK_MAX = 4000;

const useFeedback = create<{ open: boolean; draft: string }>(() => ({ open: false, draft: '' }));
export const openFeedback = () => useFeedback.setState({ open: true });

export function FeedbackHost() {
  const open = useFeedback((s) => s.open);
  if (!open) return null;
  return <FeedbackDialog />;
}

function FeedbackDialog() {
  const draft = useFeedback((s) => s.draft);
  const [busy, setBusy] = useState(false);
  const close = () => useFeedback.setState({ open: false });
  const text = draft.trim();
  const tooLong = draft.length > FEEDBACK_MAX;

  const submit = async () => {
    if (!text || tooLong || busy) return;
    setBusy(true);
    try {
      await post('/feedback', {
        message: text,
        page: location.pathname, // the in-app path only: no query or hash
        client: { version: import.meta.env.VITE_APP_VERSION || 'dev', platform: detectPlatform() },
      });
      useFeedback.setState({ open: false, draft: '' });
      toast('Thanks, your feedback was sent.');
    } catch (e) {
      errorToast(e); // the dialog stays open with the draft
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Send feedback"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!text || tooLong} loading={busy}>
            Send
          </Button>
        </>
      }
    >
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="feedback-message">
            What's on your mind?
          </label>
          <textarea
            id="feedback-message"
            className="input feedback-text"
            rows={6}
            autoFocus
            required
            maxLength={FEEDBACK_MAX + 500}
            value={draft}
            placeholder="A bug, an idea, something confusing…"
            aria-describedby="feedback-note feedback-count"
            onChange={(e) => useFeedback.setState({ draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className={`field-hint feedback-count ${tooLong ? 'is-error' : ''}`} id="feedback-count" aria-live="polite">
            {draft.length} / {FEEDBACK_MAX}
          </div>
        </div>
        <p className="field-hint" id="feedback-note">
          This goes to the {APP_NAME} team along with your name and email, the page you are on, and your app version and device type. We may reply by email.
        </p>
      </form>
    </Dialog>
  );
}
