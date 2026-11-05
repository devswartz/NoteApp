// App-wide promise-based dialogs, so any area can ask without native confirm()/prompt():
//   if (await confirmDialog({ title: 'Delete page?', confirmLabel: 'Delete', danger: true })) …
//   const name = await promptDialog({ title: 'New section', label: 'Name' });
// <DialogHost /> is mounted once by the app shell.
import { useEffect, useState, type ReactNode } from 'react';
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
}

type Pending =
  | { type: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { type: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void };

const useDialogs = create<{ current: Pending | null }>(() => ({ current: null }));

function open(p: Pending) {
  // A new dialog cancels whatever was open.
  const prev = useDialogs.getState().current;
  if (prev) prev.type === 'confirm' ? prev.resolve(false) : prev.resolve(null);
  useDialogs.setState({ current: p });
}

export const confirmDialog = (opts: ConfirmOpts) => new Promise<boolean>((resolve) => open({ type: 'confirm', opts, resolve }));
export const promptDialog = (opts: PromptOpts) => new Promise<string | null>((resolve) => open({ type: 'prompt', opts, resolve }));

export function DialogHost() {
  const current = useDialogs((s) => s.current);
  const [value, setValue] = useState('');
  useEffect(() => {
    if (current?.type === 'prompt') setValue(current.opts.initial ?? '');
  }, [current]);
  if (!current) return null;

  const finish = (v: boolean) => {
    useDialogs.setState({ current: null });
    if (current.type === 'confirm') current.resolve(v);
    else current.resolve(v && value.trim() ? value.trim() : null);
  };

  if (current.type === 'confirm') {
    const o = current.opts;
    return (
      <Dialog
        open
        size="sm"
        onClose={() => finish(false)}
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
        <Input label={o.label} value={value} placeholder={o.placeholder} onChange={(e) => setValue(e.target.value)} autoFocus onFocus={(e) => e.currentTarget.select()} />
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
