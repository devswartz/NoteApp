// A per-page, in-memory clipboard for e2e tests. The real system clipboard is shared by everything on the machine, so with
// several workers one test could read what another had just copied (40-line-picks reading "Hello", 46-copy-formatting flaking).
// This replaces navigator.clipboard (write / writeText / read / readText) with a store that belongs to the page, records what
// copy and cut events put on a DataTransfer (the browser's own Ctrl+C), and turns Ctrl/Cmd+V into a paste event fed from that
// store, so copy and paste work end to end without touching the system clipboard. Call before the page loads.
import type { Page } from '@playwright/test';

export async function stubClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Kept in sessionStorage so it survives going to another page of the app (the same tab), like the real one.
    const KEY = '__e2e_clipboard';
    const store: Record<string, string> = (() => {
      try {
        return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, string>;
      } catch {
        return {};
      }
    })();
    const replace = (data: Record<string, string>) => {
      for (const k of Object.keys(store)) delete store[k];
      Object.assign(store, data);
      try {
        sessionStorage.setItem(KEY, JSON.stringify(store));
      } catch {
        // storage unavailable: the clipboard lasts for this document only
      }
    };
    const clipboard = {
      async writeText(text: string) {
        replace({ 'text/plain': String(text) });
      },
      async write(items: ClipboardItem[]) {
        const data: Record<string, string> = {};
        for (const item of items) for (const type of item.types) data[type] = await (await item.getType(type)).text();
        replace(data);
      },
      async readText() {
        return store['text/plain'] ?? '';
      },
      async read() {
        const types = Object.keys(store);
        return types.length ? [new ClipboardItem(Object.fromEntries(types.map((t) => [t, new Blob([store[t]!], { type: t })])))] : [];
      },
    };
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });

    // The browser's own copy / cut: whatever the editor put on the event is the clipboard now.
    const record = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const data: Record<string, string> = {};
      for (const type of dt.types) if (type.startsWith('text/')) data[type] = dt.getData(type);
      if (Object.keys(data).length) replace(data);
    };
    document.addEventListener('copy', record);
    document.addEventListener('cut', record);

    // Ctrl/Cmd+V: paste from the stub (an untrusted paste event, which the editor handles like a real one).
    window.addEventListener(
      'keydown',
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'v') return;
        e.preventDefault();
        const dt = new DataTransfer();
        for (const [type, value] of Object.entries(store)) dt.setData(type, value);
        (document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      },
      true,
    );
  });
}
