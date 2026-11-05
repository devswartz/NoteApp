// Small in-page dialogs for the desktop shell's own prompts (server setup,
// updates). Plain DOM, so they work before React renders; styled with the
// design tokens from src/styles.css.

export interface DialogParts {
  root: HTMLDivElement;
  body: HTMLDivElement;
  actions: HTMLDivElement;
  close(): void;
}

export function openDialog(title: string, { dismissable = true } = {}): DialogParts {
  const root = document.createElement('div');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.style.cssText =
    'position:fixed;inset:0;z-index:var(--z-modal,1000);display:grid;place-items:center;padding:24px;background:var(--bg-overlay,rgba(0,0,0,.4));font-family:var(--font,system-ui)';
  const card = document.createElement('div');
  card.style.cssText =
    'width:min(420px,100%);background:var(--bg-elevated,#fff);color:var(--text,#111);border:1px solid var(--border,#ddd);border-radius:var(--radius-lg,12px);box-shadow:var(--shadow-lg);padding:20px;display:grid;gap:12px';
  const h = document.createElement('h2');
  h.textContent = title;
  h.style.cssText = 'margin:0;font-size:var(--text-lg,17px);font-weight:600';
  const body = document.createElement('div');
  body.style.cssText = 'display:grid;gap:8px;font-size:var(--text-sm,13px);color:var(--text-2,#555)';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:4px';
  card.append(h, body, actions);
  root.append(card);
  const close = () => {
    root.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && dismissable) {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(root);
  return { root, body, actions, close };
}

export function button(label: string, kind: 'primary' | 'secondary', onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn btn-${kind}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function message(text: string): Promise<void> {
  return new Promise((resolve) => {
    const d = openDialog(document.title || 'Notice');
    d.body.textContent = text;
    const ok = button('OK', 'primary', () => {
      d.close();
      resolve();
    });
    d.actions.append(ok);
    ok.focus();
  });
}

export function ask(text: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const d = openDialog(document.title || 'Confirm');
    d.body.textContent = text;
    const done = (v: boolean) => {
      d.close();
      resolve(v);
    };
    const yes = button(confirmLabel, 'primary', () => done(true));
    d.actions.append(button('Not now', 'secondary', () => done(false)), yes);
    yes.focus();
  });
}
