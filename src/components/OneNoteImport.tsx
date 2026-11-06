// Settings → General → Import from OneNote (#117): sign in with Microsoft, tick notebooks, import, watch progress.
// Hidden when the server doesn't have the feature configured (GET /import/onenote is a 404 then).
// The Microsoft sign-in ends on this Settings screen with ?onenote=<connection id> (or "denied"/"failed").
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FileUp } from 'lucide-react';
import { get, post } from '../api.ts';
import { errorToast } from '../store.ts';
import { platform } from '../platform/index.ts';
import { Button } from './ui.tsx';

interface Job {
  id: string;
  status: 'running' | 'done' | 'partial' | 'cancelled' | 'failed';
  incomplete: boolean;
  notebooks: { total: number; done: number };
  pages: { total: number; done: number };
  images: number;
  attachments: number;
  tasks: number;
  imported: { id: string; name: string }[];
  warnings: string[];
  error: string | null;
}

const COL = { display: 'flex', flexDirection: 'column', gap: 10 } as const;

export const ONENOTE_LIMITATIONS = [
  'OneNote’s free-form page layout becomes a normal top-to-bottom flow.',
  'Ink and drawings come through as images when OneNote provides them, otherwise they are skipped.',
  'Password-protected sections can’t be read and are skipped.',
  'Large notebooks can take a while: Microsoft limits how fast they can be read.',
];

export function OneNoteImport({ wsId }: { wsId: string }) {
  const [params, setParams] = useSearchParams();
  const [conn, setConn] = useState<string | null>(null);
  const [notebooks, setNotebooks] = useState<{ id: string; name: string }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [account, setAccount] = useState<{ name: string; email: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (poll.current) clearTimeout(poll.current);
    },
    [],
  );

  // Back from Microsoft: take the connection id out of the URL (it's single-use) and list the notebooks.
  useEffect(() => {
    const v = params.get('onenote');
    if (!v) return;
    const next = new URLSearchParams(params);
    next.delete('onenote');
    setParams(next, { replace: true });
    if (v === 'denied') return setMessage('Microsoft sign-in was cancelled.');
    if (v === 'failed') return setMessage('Microsoft sign-in failed. Try again.');
    setConn(v);
    setBusy(true);
    setConfirmed(false);
    get<{ account: { name: string; email: string } | null; notebooks: { id: string; name: string }[] }>(`/import/onenote/connections/${encodeURIComponent(v)}/notebooks`)
      .then((r) => {
        setAccount(r.account);
        setNotebooks(r.notebooks);
      })
      .catch(errorToast)
      .finally(() => setBusy(false));
  }, [params, setParams]);


  const signIn = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { url } = await post<{ url: string }>('/import/onenote/start', { workspaceId: wsId });
      platform.openExternal(url);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };

  const watch = (id: string) => {
    get<Job>(`/import/onenote/jobs/${id}`)
      .then((j) => {
        setJob(j);
        if (j.status === 'running') poll.current = setTimeout(() => watch(id), 1000);
      })
      .catch(errorToast);
  };

  const start = async () => {
    if (!conn) return;
    setBusy(true);
    try {
      const j = await post<Job>(`/import/onenote/connections/${encodeURIComponent(conn)}/import`, { notebookIds: [...picked], confirmedAccount: confirmed });
      setJob(j);
      setNotebooks(null);
      setConn(null);
      watch(j.id);
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };

  const limitations = (
    <ul className="muted small">
      {ONENOTE_LIMITATIONS.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );

  if (job) {
    const pct = job.pages.total ? Math.round((job.pages.done / job.pages.total) * 100) : 0;
    return (
      <div style={COL} aria-live="polite">
        {job.status === 'running' && (
          <>
            <progress max={100} value={pct} aria-label="Import progress" style={{ width: '100%' }} />
            <p className="small">
              Importing… notebooks {job.notebooks.done}/{job.notebooks.total} · pages {job.pages.done}/{job.pages.total} · {job.images} images · {job.attachments} attachments · {job.tasks} tasks
            </p>
          </>
        )}
        {job.status !== 'running' && (
          <p className="small">
            {job.status === 'done' ? 'Imported' : 'So far:'} {job.pages.done} pages, {job.images} images, {job.attachments} attachments and {job.tasks} tasks into{' '}
            {job.imported.map((n, i) => (
              <span key={n.id}>
                {i > 0 && ', '}
                <strong>{n.name}</strong>
              </span>
            ))}
            {job.imported.length ? ' (private notebooks in the sidebar). ' : '. '}
            <Link to={`/w/${wsId}/notes`}>Open notes</Link> · <Link to={`/w/${wsId}/tasks/today`}>Open tasks</Link>
          </p>
        )}
        {job.status === 'running' && (
          <div>
            <Button onClick={() => post(`/import/onenote/jobs/${job.id}/cancel`).catch(errorToast)}>Cancel import</Button>
          </div>
        )}
        {job.status !== 'running' && job.status !== 'done' && (
          <p className="small" role="alert">
            The import stopped ({job.error ?? job.status}). What was imported so far is kept; notebooks that weren’t finished are marked “(incomplete)”.
          </p>
        )}
        {job.warnings.length > 0 && (
          <details className="small">
            <summary>{job.warnings.length} item(s) skipped</summary>
            <ul>
              {job.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        {job.status !== 'running' && (
          <div>
            <Button onClick={() => setJob(null)}>Import more</Button>
          </div>
        )}
      </div>
    );
  }

  if (notebooks) {
    return (
      <div style={COL}>
        {notebooks.length === 0 && <p className="muted small">No notebooks found in this Microsoft account.</p>}
        <fieldset style={{ ...COL, gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="small">Choose notebooks to import</legend>
          {notebooks.map((n) => (
            <label key={n.id} className="row gap-6">
              <input
                type="checkbox"
                checked={picked.has(n.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(n.id);
                  else next.delete(n.id);
                  setPicked(next);
                }}
              />
              {n.name}
            </label>
          ))}
        </fieldset>
        <label className="row gap-6 small">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>
            This is my Microsoft account: <strong>{account ? `${account.name}${account.email ? ` (${account.email})` : ''}` : 'unknown account'}</strong>
          </span>
        </label>
        {limitations}
        <div className="row gap-10">
          <Button variant="primary" loading={busy} disabled={!picked.size || !confirmed || busy} onClick={() => void start()}>
            Import {picked.size || ''} notebook{picked.size === 1 ? '' : 's'}
          </Button>
          <Button onClick={() => setNotebooks(null)}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <div style={COL}>
      {message && <p className="small">{message}</p>}
      {limitations}
      <div>
        <Button icon={<FileUp size={15} />} loading={busy} disabled={busy} onClick={() => void signIn()}>
          Import from OneNote…
        </Button>
      </div>
    </div>
  );
}

/** Whether the server has OneNote import configured (Settings shows the card only then). */
export function useOneNoteEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    get('/import/onenote').then(() => setOn(true), () => setOn(false));
  }, []);
  return on;
}
