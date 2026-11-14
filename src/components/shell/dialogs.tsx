// App-wide promise-based dialogs, so any area can ask without native confirm()/prompt():
//   if (await confirmDialog({ title: 'Delete page?', confirmLabel: 'Delete', danger: true })) …
//   const name = await promptDialog({ title: 'New section', label: 'Name' });
// <DialogHost /> is mounted once by the app shell.
import { useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { Button, Dialog, Input } from '../ui.tsx';

interface ConfirmOpts {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PromptOpts {
  title: string;
  label?: string;
  message?: ReactNode;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** A password field: masked, and the value is returned as typed (not trimmed). */
  password?: boolean;
  autoComplete?: string;
}

type Pending =
  | { type: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean | null) => void }
  | { type: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void };

const useDialogs = create<{ current: Pending | null }>(() => ({ current: null }));

function open(p: Pending) {
  // A new dialog cancels whatever was open.
  const prev = useDialogs.getState().current;
  if (prev) prev.resolve(null);
  useDialogs.setState({ current: p });
}

export const confirmDialog = (opts: ConfirmOpts) => new Promise<boolean>((resolve) => open({ type: 'confirm', opts, resolve: (v) => resolve(!!v) }));
/** A choice of two: true (the confirm button), false (the cancel button) or null (dismissed). */
export const chooseDialog = (opts: ConfirmOpts) => new Promise<boolean | null>((resolve) => open({ type: 'confirm', opts, resolve }));
export const promptDialog = (opts: PromptOpts) => new Promise<string | null>((resolve) => open({ type: 'prompt', opts, resolve }));

export function DialogHost() {
  const current = useDialogs((s) => s.current);
  // The typed value belongs to one dialog: a new one starts from its `initial`. (Resetting it in an effect raced with
  // typing: text entered right after the dialog appeared could be wiped.)
  const [typed, setTyped] = useState<{ for: Pending | null; value: string }>({ for: null, value: '' });
  const value = typed.for === current ? typed.value : current?.type === 'prompt' ? (current.opts.initial ?? '') : '';
  const setValue = (v: string) => setTyped({ for: current, value: v });
  if (!current) return null;

  const finish = (v: boolean | null) => {
    useDialogs.setState({ current: null });
    if (current.type === 'confirm') current.resolve(v);
    else current.resolve(v && value.trim() ? (current.opts.password ? value : value.trim()) : null);
  };

  if (current.type === 'confirm') {
    const o = current.opts;
    return (
      <Dialog
        open
        size="sm"
        onClose={() => finish(null)}
        title={o.title}
        description={o.message}
        footer={
          <>
            <Button variant="ghost" onClick={() => finish(false)}>
              {o.cancelLabel ?? 'Cancel'}
            </Button>
            <Button variant={o.danger ? 'danger' : 'primary'} onClick={() => finish(true)} autoFocus>
              {o.confirmLabel ?? 'OK'}
            </Button>
          </>
        }
      />
    );
  }

  const o = current.opts;
  return (
    <Dialog open size="sm" onClose={() => finish(false)} title={o.title} description={o.message}>
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        <Input
          label={o.label}
          value={value}
          placeholder={o.placeholder}
          type={o.password ? 'password' : undefined}
          autoComplete={o.autoComplete}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="dialog-foot flush">
          <Button variant="ghost" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!value.trim()}>
            {o.confirmLabel ?? 'Save'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
