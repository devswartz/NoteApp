// Notes overview: on mobile this is the "Notes" tab (a browsable list);
// on desktop it shows recently edited pages.
import { Link, useParams } from 'react-router-dom';
import { FileText, Lock } from 'lucide-react';
import { useStore } from '../store.ts';
import { relativeTime } from '../lib/format.ts';
import { sectionPathLabel, sectionsInOrder } from '../../shared/sections.ts';

export function NotesHome() {
  const { wsId } = useParams();
  const tree = useStore((s) => s.tree);
  const recent = [...tree.pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  return (
    <div className="tasks-page">
      <div className="tasks-inner">
        <header className="view-head">
          <h1>Notes</h1>
        </header>
        {recent.length > 0 && (
          <section className="task-group">
            <h3 className="group-title">Recently edited</h3>
            <div className="recent-grid">
              {recent.map((p) => (
                <Link key={p.id} to={`/w/${wsId}/p/${p.id}`} className="recent-card">
                  {p.icon ? <span className="page-emoji">{p.icon}</span> : <FileText size={18} className="muted" />}
                  <strong className="truncate">{p.title || 'Untitled'}</strong>
                  <span className="muted small">{relativeTime(p.updatedAt)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
        {tree.notebooks.map((nb) => (
          <section key={nb.id} className="task-group">
            <h3 className="group-title">
              <span className="nb-icon" style={{ background: nb.color }}>
                {nb.name[0]?.toUpperCase()}
              </span>
              {nb.name}
              {nb.visibility === 'private' && <Lock size={12} />}
            </h3>
            {sectionsInOrder(tree, nb.id)
              .map(({ section: s }) => (
                <div key={s.id} className="notes-section">
                  <div className="notes-section-title">
                    <span className="sec-tab" style={{ background: s.color }} />
                    {sectionPathLabel(tree, s.id)}
                  </div>
                  {tree.pages
                    .filter((p) => p.sectionId === s.id)
                    .map((p) => (
                      <Link key={p.id} to={`/w/${wsId}/p/${p.id}`} className="notes-page-row">
                        {p.icon ? <span className="page-emoji page-emoji-sm">{p.icon}</span> : <FileText size={15} className="muted" />}
                        <span className="truncate grow">{p.title || 'Untitled'}</span>
                        <span className="muted small">{relativeTime(p.updatedAt)}</span>
                      </Link>
                    ))}
                </div>
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}
