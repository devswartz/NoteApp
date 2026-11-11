// Page version history: a list of snapshots, a read-only preview, and Restore.
// Restoring replaces the live document through the editor (one collaborative edit,
// so everyone sees it and it can be undone), after snapshotting the current state.
// Canvas pages: the preview shows the boxes in reading order, and Restore puts back the whole
// doc (boxes and their places) in one transaction. A version from before the page was converted
// is shown, and restored, in the page's current kind.
import { useEffect, useMemo, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { History, RotateCcw } from 'lucide-react';
import { get, post } from '../api.ts';
import { errorToast, toast, useStore } from '../store.ts';
import { Modal } from '../components/ui.tsx';
import { relativeTime } from '../lib/format.ts';
import { documentExtensions } from './NoteEditor.tsx';
import { boxField, boxGeoms, convertPageDoc, readingOrder, replacePageContent } from '../../shared/pageDoc.ts';
import { newBoxId } from './canvasGeom.ts';
import type { CanvasHandle } from './canvasDoc.ts';

interface VersionMeta {
  id: string;
  title: string;
  authorId: string | null;
  reason: 'auto' | 'restore' | 'manual';
  at: string;
  createdAt: string;
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function VersionHistory({
  pageId,
  editor,
  canvas = null,
  canvasEditable = false,
  open,
  onClose,
  othersEditing = 0,
}: {
  pageId: string;
  /** The live document editor (document pages). */
  editor: Editor | null;
  /** The live canvas (canvas pages). */
  canvas?: CanvasHandle | null;
  /** May restore on a canvas page. */
  canvasEditable?: boolean;
  open: boolean;
  onClose: () => void;
  /** People other than me on the page right now (presence). */
  othersEditing?: number;
}) {
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const members = useStore((s) => s.members);

  useEffect(() => {
    if (!open) return;
    setVersions(null);
    get<VersionMeta[]>(`/pages/${pageId}/versions`)
      .then((v) => {
        setVersions(v);
        setSelected(v[0]?.id ?? null);
      })
      .catch((e) => {
        errorToast(e);
        setVersions([]);
      });
  }, [open, pageId]);

  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} className="history-modal" label="Version history">
      <div className="history">
        <aside className="history-list">
          <div className="history-head">
            <History size={16} /> Version history
          </div>
          {versions === null && <div className="muted small history-empty">Loading…</div>}
          {versions?.length === 0 && (
            <div className="muted small history-empty">No earlier versions yet. Snapshots are taken every few minutes while a page is being edited.</div>
          )}
          {versions?.map((v) => {
            const who = members.find((m) => m.id === v.authorId);
            return (
              <button key={v.id} type="button" className={`history-item ${selected === v.id ? 'is-active' : ''}`} onClick={() => setSelected(v.id)}>
                <span className="history-when">{fmt(v.at)}</span>
                <span className="history-meta muted small">
                  {who ? who.name : 'Unknown'} · {relativeTime(v.at)}
                  {v.reason === 'restore' ? ' · before restore' : v.reason === 'manual' ? ' · saved' : ''}
                </span>
              </button>
            );
          })}
        </aside>
        <section className="history-preview">
          {selected ? <Preview key={selected} pageId={pageId} versionId={selected} live={editor} canvas={canvas} canvasEditable={canvasEditable} onRestored={onClose} othersEditing={othersEditing} /> : <div className="history-placeholder muted">Select a version</div>}
        </section>
      </div>
    </Modal>
  );
}

function Preview({
  pageId,
  versionId,
  live,
  canvas,
  canvasEditable,
  onRestored,
  othersEditing,
}: {
  pageId: string;
  versionId: string;
  live: Editor | null;
  canvas: CanvasHandle | null;
  canvasEditable: boolean;
  onRestored: () => void;
  othersEditing: number;
}) {
  const doc = useMemo(() => new Y.Doc(), []);
  const [loaded, setLoaded] = useState<VersionMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = canvas ? canvasEditable : !!live?.isEditable;
  const boxIds = loaded && canvas ? readingOrder(boxGeoms(doc)).map((b) => b.id) : [];

  useEffect(() => {
    let cancelled = false;
    get<VersionMeta & { ydoc: string }>(`/pages/${pageId}/versions/${versionId}`)
      .then((v) => {
        if (cancelled) return;
        Y.applyUpdate(doc, decode(v.ydoc));
        // Shown (and restored) as the page is now, even if it was converted since.
        convertPageDoc(doc, canvas ? 'canvas' : 'document', newBoxId);
        setLoaded(v);
      })
      .catch(errorToast);
    return () => {
      cancelled = true;
    };
  }, [pageId, versionId, doc]);

  useEffect(() => () => doc.destroy(), [doc]);

  const preview = useEditor(
    {
      editable: false,
      extensions: [...documentExtensions(pageId), Collaboration.configure({ document: doc, field: 'default' })],
      editorProps: { attributes: { class: 'prose' } },
    },
    [doc],
  );

  const restore = async () => {
    if (!canvas && (!live || !preview || live.isDestroyed)) return;
    if (othersEditing > 0) {
      const who = othersEditing === 1 ? '1 other person is' : `${othersEditing} other people are`;
      const ok = confirm(
        `${who} editing this page. Restoring will replace their current changes too. ` +
          `Nothing is lost: the current page is saved as a “before restore” version first. Restore anyway?`,
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      // Keep the current state as a version too, so the restore can be undone from here.
      await post(`/pages/${pageId}/versions`, { reason: 'restore' });
      if (canvas) replacePageContent(canvas.doc, doc, 'canvas', newBoxId);
      else live!.chain().setContent(preview!.getJSON()).focus('start').run();
      toast(`Restored the version from ${fmt(loaded!.at)}`);
      onRestored();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="history-preview-bar">
        <span className="muted small">{loaded ? `${loaded.title || 'Untitled'} · ${fmt(loaded.at)}` : 'Loading…'}</span>
        {canEdit && (
          <button type="button" className="btn btn-primary btn-sm" disabled={!loaded || busy} onClick={() => void restore()}>
            <RotateCcw size={14} /> Restore this version
          </button>
        )}
      </div>
      <div className="history-doc">
        {canvas ? (
          boxIds.length ? (
            boxIds.map((id) => <PreviewBox key={id} pageId={pageId} doc={doc} id={id} />)
          ) : (
            loaded && <p className="muted">This version is empty.</p>
          )
        ) : (
          <EditorContent editor={preview} />
        )}
      </div>
    </>
  );
}

/** One box of a canvas version, read-only. */
function PreviewBox({ pageId, doc, id }: { pageId: string; doc: Y.Doc; id: string }) {
  const ed = useEditor(
    {
      editable: false,
      extensions: [...documentExtensions(pageId), Collaboration.configure({ document: doc, field: boxField(id) })],
      editorProps: { attributes: { class: 'prose' } },
    },
    [doc, id],
  );
  return (
    <div className="history-box" data-box-id={id}>
      <EditorContent editor={ed} />
    </div>
  );
}
