// Notes overview (/notes).
// Phones: step-by-step screens, notebooks → sections → pages, with Back at each
//   step: /notes, /notes?nb=<id>, /notes?nb=<id>&sec=<id>.
// Desktop: an empty section (?sec=) offers a first page; otherwise recently
//   edited pages and every notebook at a glance.
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, FilePlus, FileText, Lock, Plus, Star } from 'lucide-react';
import { post } from '../api.ts';
import { errorToast, useStore } from '../store.ts';
import { relativeTime } from '../lib/format.ts';
import { useIsMobile } from '../components/ui.tsx';
import type { Notebook, PageMeta, Section } from '../../shared/types.ts';
import { childSections, parentOf, splitNotebooks } from '../components/shell/navState.ts';
import { byPos } from '../components/shell/treePosition.ts';
import { sortPages } from '../components/shell/NotesPanel.tsx';
import { useSidebar } from '../components/shell/sidebarState.ts';
import { SharedWithMe } from '../components/sharing/SharedWithMe.tsx';

function useCreatePage(wsId: string) {
  const navigate = useNavigate();
  return (sectionId: string) =>
    post<{ id: string }>(`/sections/${sectionId}/pages`, { title: '' })
      .then(({ id }) => navigate(`/w/${wsId}/p/${id}`))
      .catch(errorToast);
}
import { sectionPathLabel, sectionsInOrder } from '../../shared/sections.ts';

export function NotesHome() {
  const { wsId } = useParams() as { wsId: string };
  const isMobile = useIsMobile();
  const [params] = useSearchParams();
  const tree = useStore((s) => s.tree);
  const sec = tree.sections.find((s) => s.id === params.get('sec'));
  const nb = tree.notebooks.find((n) => n.id === (params.get('nb') ?? sec?.notebookId));
  if (isMobile) {
    if (sec) return <SectionScreen wsId={wsId} section={sec} />;
    if (nb) return <NotebookScreen wsId={wsId} nb={nb} />;
    return <NotebooksScreen wsId={wsId} />;
  }
  if (sec) return <EmptySection wsId={wsId} section={sec} />;
  return <Overview wsId={wsId} />;
}

function Screen({ title, back, icon, children, action }: { title: string; back?: string; icon?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="tasks-page notes-drill">
      <div className="tasks-inner">
        {back && (
          <Link to={back} className="drill-back">
            <ChevronLeft size={18} /> Back
          </Link>
        )}
        <header className="view-head drill-head">
          {icon}
          <h1 className="truncate">{title}</h1>
          {action}
        </header>
        {children}
      </div>
    </div>
  );
}

const nbIcon = (n: Notebook) => (
  <span className="nb-icon" aria-hidden="true" style={{ background: n.color }}>
    {n.name[0]?.toUpperCase()}
  </span>
);

function NotebooksScreen({ wsId }: { wsId: string }) {
  const tree = useStore((s) => s.tree);
  const me = useStore((s) => s.user!.id);
  const favorites = useSidebar((s) => s.favorites[wsId]);
  const { mine, shared } = splitNotebooks(tree.notebooks, me);
  const favPages = (favorites ?? []).map((id) => tree.pages.find((p) => p.id === id)).filter((p): p is PageMeta => !!p);
  const row = (n: Notebook) => (
    <Link key={n.id} to={`/w/${wsId}/notes?nb=${n.id}`} className="drill-row">
      {nbIcon(n)}
      <span className="truncate grow">{n.name}</span>
      {n.visibility === 'private' && <Lock size={13} className="muted" aria-label="Private notebook" />}
      <ChevronRight size={17} className="muted" />
    </Link>
  );
  return (
    <Screen title="Notes">
      {favPages.length > 0 && (
        <section className="task-group">
          <h3 className="group-title">Favourites</h3>
          {favPages.map((p) => (
            <PageLink key={p.id} wsId={wsId} page={p} icon={<Star size={15} className="muted" />} />
          ))}
        </section>
      )}
      {mine.length > 0 && (
        <section className="task-group">
          <h3 className="group-title">My notebooks</h3>
          {mine.map(row)}
        </section>
      )}
      {shared.length > 0 && (
        <section className="task-group">
          <h3 className="group-title">Shared with me</h3>
          {shared.map(row)}
        </section>
      )}
      <SharedWithMe wsId={wsId} />
      {!tree.notebooks.length && <p className="muted">No notebooks yet.</p>}
    </Screen>
  );
}

function NotebookScreen({ wsId, nb }: { wsId: string; nb: Notebook }) {
  const tree = useStore((s) => s.tree);
  const sections = childSections(tree, nb.id, null);
  return (
    <Screen title={nb.name} back={`/w/${wsId}/notes`} icon={nbIcon(nb)}>
      <section className="task-group" aria-label="Sections">
        {sections.map((s) => (
          <SectionLink key={s.id} wsId={wsId} section={s} />
        ))}
        {!sections.length && <p className="muted">No sections in this notebook.</p>}
      </section>
    </Screen>
  );
}

function SectionLink({ wsId, section }: { wsId: string; section: Section }) {
  const count = useStore((s) => s.tree.pages.filter((p) => p.sectionId === section.id).length);
  return (
    <Link to={`/w/${wsId}/notes?nb=${section.notebookId}&sec=${section.id}`} className="drill-row">
      <span className="sec-tab" style={{ background: section.color }} />
      <span className="truncate grow">{section.name}</span>
      <span className="muted small">{count}</span>
      <ChevronRight size={17} className="muted" />
    </Link>
  );
}

function PageLink({ wsId, page, icon }: { wsId: string; page: PageMeta; icon?: React.ReactNode }) {
  return (
    <Link to={`/w/${wsId}/p/${page.id}`} className="drill-row">
      {icon ?? (page.icon ? <span className="page-emoji">{page.icon}</span> : <FileText size={15} className="muted" />)}
      <span className="truncate grow">{page.title || 'Untitled'}</span>
      <span className="muted small">{relativeTime(page.updatedAt)}</span>
    </Link>
  );
}

function SectionScreen({ wsId, section }: { wsId: string; section: Section }) {
  const tree = useStore((s) => s.tree);
  const sort = useSidebar((s) => s.pageSort);
  const canEdit = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
  const createPage = useCreatePage(wsId);
  const subs = childSections(tree, section.notebookId, section.id);
  const pages = sortPages(tree.pages.filter((p) => p.sectionId === section.id), sort);
  const parent = parentOf(section);
  const back = parent ? `/w/${wsId}/notes?nb=${section.notebookId}&sec=${parent}` : `/w/${wsId}/notes?nb=${section.notebookId}`;
  return (
    <Screen
      title={section.name}
      back={back}
      icon={<span className="sec-tab" style={{ background: section.color }} />}
      action={
        canEdit && (
          <button className="btn btn-secondary btn-sm drill-new" onClick={() => createPage(section.id)}>
            <Plus size={15} /> New page
          </button>
        )
      }
    >
      {subs.length > 0 && (
        <section className="task-group" aria-label="Subsections">
          {subs.map((s) => (
            <SectionLink key={s.id} wsId={wsId} section={s} />
          ))}
        </section>
      )}
      <section className="task-group" aria-label="Pages">
        {pages.map((p) => (
          <PageLink key={p.id} wsId={wsId} page={p} />
        ))}
        {!pages.length && <p className="muted">No pages in this section yet.</p>}
      </section>
    </Screen>
  );
}

function EmptySection({ wsId, section }: { wsId: string; section: Section }) {
  const canEdit = useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
  const createPage = useCreatePage(wsId);
  return (
    <div className="empty-section">
      <FileText size={28} className="muted" />
      <h1>{section.name}</h1>
      <p className="muted">This section has no pages yet.</p>
      {canEdit && (
        <button className="btn btn-primary" onClick={() => createPage(section.id)}>
          <FilePlus size={15} /> New page
        </button>
      )}
    </div>
  );
}

function Overview({ wsId }: { wsId: string }) {
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
        {[...tree.notebooks].sort(byPos).map((nb) => (
          <section key={nb.id} className="task-group">
            <h3 className="group-title">
              {nbIcon(nb)}
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
                    .sort(byPos)
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
