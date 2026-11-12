// The ribbon in every section (desktop and tablet; phones have none): the note's ribbon on a
// page (src/editor/Toolbar.tsx), and here the Tasks, Calendar, Notes overview and Settings
// ribbons. Same frame, look and collapse state everywhere. They drive the state the pages
// already use, so the two stay in sync both ways: the task views' store
// (src/pages/tasks/taskViewState.ts), saved views, and the calendar's URL (?d, mode, who, tags, team).
import type { ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUpDown,
  BookPlus,
  Bookmark,
  BookmarkPlus,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  FilePlus,
  FilterX,
  Flag,
  FolderPlus,
  Inbox,
  Layers,
  ListChecks,
  Plus,
  SlidersHorizontal,
  Sun,
  Tag,
  Upload,
  User,
  Users,
  UsersRound,
} from 'lucide-react';
import { Group, Ribbon, RibbonButton, RibbonFrame, RibbonMenu, Sep } from '../../editor/Toolbar.tsx';
import { pickMarkdownFiles, setPendingImport } from '../../editor/exportPage.ts';
import { post } from '../../api.ts';
import { errorToast, toast, ui, useStore } from '../../store.ts';
import { MenuItem, MenuLabel, MenuSeparator } from '../ui.tsx';
import { LabelDot } from '../Labels.tsx';
import { useOneNoteEnabled } from '../OneNoteImport.tsx';
import { promptDialog } from './dialogs.tsx';
import { openNewNotebook } from './NewNotebookDialog.tsx';
import { useNotesSelection, viewTarget } from './navState.ts';
import { orderedTeams, teamLabel, type GroupKey, type ViewId } from '../../lib/taskViews.ts';
import { today } from '../../../shared/dates.ts';
import { taskView, useTaskView, type MyGroup } from '../../pages/tasks/taskViewState.ts';
import { AddFilterMenu, KINDS, KindMenu, activeKinds, clearedFilters, valueCount, withoutFilter, type Kind } from '../../pages/tasks/FilterChips.tsx';
import { GROUP_OPTIONS, SORT_OPTIONS, SavedViewActions, saveCurrentView, useIsWsAdmin } from '../../pages/tasks/AllView.tsx';
import { sameView, useSavedViews, type SavedView } from '../../pages/tasks/savedViews.ts';
import {
  calendarDate,
  calendarMode,
  calendarTags,
  calendarTeam,
  calendarWho,
  setCalendarDate,
  setCalendarMode,
  stepCalendar,
} from '../../pages/tasks/CalendarView.tsx';

/** Picks the ribbon for the current route. */
export function AppRibbon({ wsId, pathname }: { wsId: string; pathname: string }) {
  const rest = pathname.slice(`/w/${wsId}/`.length);
  if (rest.startsWith('p/')) return <Ribbon />;
  if (rest.startsWith('tasks/calendar')) return <CalendarRibbon />;
  if (rest.startsWith('tasks/')) return <TasksRibbon wsId={wsId} view={rest.split('/')[1] as ViewId} />;
  if (rest.startsWith('settings')) return <SettingsRibbon wsId={wsId} />;
  return <NotesRibbon wsId={wsId} />;
}

const useCanEdit = () => useStore((s) => s.workspaces.find((w) => w.id === s.wsId)?.role !== 'viewer');
const VIEWER = 'Viewers can’t add to this workspace';
const end = <span className="tb-spacer" />;

// ───────────── Tasks ─────────────

const SHOW: { id: ViewId; label: string; text: string; icon: ReactNode }[] = [
  { id: 'today', label: 'Today', text: 'Today', icon: <Sun /> },
  { id: 'upcoming', label: 'Upcoming', text: 'Upcoming', icon: <CalendarRange /> },
  { id: 'my', label: 'My Tasks', text: 'My Tasks', icon: <Inbox /> },
  { id: 'all', label: 'All Tasks', text: 'All', icon: <ListChecks /> },
  { id: 'completed', label: 'Completed', text: 'Completed', icon: <CheckCircle2 /> },
];

const MY_GROUPS: MyGroup[] = ['due', 'note', 'priority'];

/** Why Group by / Sort / Show completed don't apply to a view (undefined: they do). */
function organiseOff(view: ViewId): { group?: string; sort?: string; done?: string } {
  const fixed: Partial<Record<ViewId, string>> = {
    today: 'Today is always grouped into Overdue and Today',
    upcoming: 'Upcoming is grouped by day',
    completed: 'Completed is grouped by the day each task was finished',
    team: 'Team is grouped by person or team (switch on the page)',
  };
  if (view === 'all') return {};
  if (view === 'my') return { sort: 'My Tasks is sorted by due date; sort in All Tasks', done: 'My Tasks shows open tasks; finished ones are in Completed' };
  const g = fixed[view];
  return { group: g, sort: `${g}; sort in All Tasks`, done: view === 'completed' ? 'Completed shows only finished tasks' : 'This view shows open tasks; finished ones are in Completed' };
}

function TasksRibbon({ wsId, view }: { wsId: string; view: ViewId }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const canEdit = useCanEdit();
  const me = useStore((s) => s.user!.id);
  const isAdmin = useIsWsAdmin();
  const filters = useTaskView((s) => s.filters);
  const sort = useTaskView((s) => s.sort);
  const group = useTaskView((s) => s.group);
  const myGroup = useTaskView((s) => s.myGroup);
  const upcomingScope = useTaskView((s) => s.upcomingScope);
  const views = useSavedViews(wsId);
  const onAll = view === 'all';
  const current = onAll ? views.find((v) => sameView(v, filters, sort, group)) : undefined;
  const selected = onAll ? views.find((v) => v.id === params.get('view')) : undefined;
  const managed = current ?? selected;
  const off = organiseOff(view);
  const active = activeKinds(filters);
  const go = (id: ViewId) => navigate(`/w/${wsId}/tasks/${id}`);
  const openView = (v: SavedView) => {
    taskView.apply(v);
    navigate(`/w/${wsId}/tasks/all?view=${encodeURIComponent(v.id)}`);
  };

  const filterMenu = (kind: Kind, label: string, icon: ReactNode, count: number, off?: string) => (
    <RibbonMenu label={`${label} filter`} text={label} compact icon={icon} count={count} disabled={off}>
      <KindMenu kind={kind} filters={filters} onChange={taskView.setFilters} />
      {count > 0 && (
        <>
          <MenuSeparator />
          <MenuItem icon={<FilterX size={15} />} onSelect={() => taskView.setFilters(withoutFilter(filters, kind))}>
            Remove {label} filter
          </MenuItem>
        </>
      )}
    </RibbonMenu>
  );
  const more = KINDS.filter((k) => !['assignee', 'tagsAny', 'teamId', 'priority'].includes(k.key));
  const moreCount = active.filter((k) => more.some((m) => m.key === k)).length;

  return (
    <RibbonFrame strip="New · Show · Organise · Filter · Views" section>
      <Group label="New">
        <RibbonButton label="New task" text="New task" title="New task (Q)" icon={<Plus />} disabled={!canEdit && VIEWER} onClick={() => ui.openQuickAdd({})} />
      </Group>
      <Sep />
      <Group label="Show">
        {SHOW.map((s) => (
          <RibbonButton key={s.id} label={s.label} text={s.text} icon={s.icon} active={view === s.id} onClick={() => go(s.id)} />
        ))}
      </Group>
      <Sep />
      <Group label="Organise">
        <RibbonMenu label="Group by" text="Group" icon={<Layers />} disabled={off.group}>
          {(view === 'my' ? GROUP_OPTIONS.filter(([g]) => MY_GROUPS.includes(g as MyGroup)) : GROUP_OPTIONS).map(([g, l]) => (
            <MenuItem
              key={g}
              checked={(view === 'my' ? myGroup : group) === g}
              onSelect={() => (view === 'my' ? taskView.setMyGroup(g as MyGroup) : taskView.setGroup(g as GroupKey))}
            >
              {l}
            </MenuItem>
          ))}
        </RibbonMenu>
        <RibbonMenu label="Sort" text="Sort" icon={<ArrowUpDown />} disabled={off.sort}>
          {SORT_OPTIONS.map(([k, l]) => (
            <MenuItem key={k} checked={sort === k} onSelect={() => taskView.setSort(k)}>
              {l}
            </MenuItem>
          ))}
        </RibbonMenu>
        <RibbonButton
          label="Show completed"

          icon={<Eye />}
          active={filters.status !== 'open'}
          disabled={off.done}
          title={filters.status === 'done' ? 'Showing only completed tasks (this saved view)' : undefined}
          onClick={() => taskView.setFilters((f) => ({ ...f, status: f.status === 'open' ? 'any' : 'open' }))}
        />
      </Group>
      <Sep />
      <Group label="Filter">
        {view === 'upcoming' ? (
          <RibbonMenu label="Assignee filter" text="Assignee" compact icon={<User />} count={upcomingScope === 'all' ? 0 : 1} title={upcomingScope === 'mine' ? 'Showing your tasks' : 'Showing everyone’s tasks'}>
            <MenuItem checked={upcomingScope === 'mine'} onSelect={() => taskView.setUpcomingScope('mine')}>
              Me
            </MenuItem>
            <MenuItem checked={upcomingScope === 'all'} onSelect={() => taskView.setUpcomingScope('all')}>
              Everyone
            </MenuItem>
          </RibbonMenu>
        ) : (
          filterMenu('assignee', 'Assignee', <User />, valueCount('assignee', filters), view === 'my' ? 'My Tasks only shows tasks assigned to you' : undefined)
        )}
        {filterMenu('tagsAny', 'Tags', <Tag />, valueCount('tagsAny', filters))}
        {filterMenu('teamId', 'Team', <UsersRound />, valueCount('teamId', filters))}
        {filterMenu('priority', 'Priority', <Flag />, valueCount('priority', filters))}
        <RibbonMenu label="More filters" icon={<SlidersHorizontal />} count={moreCount} bare>
          {(close) => <AddFilterMenu filters={filters} onChange={taskView.setFilters} active={[]} close={close} kinds={more} />}
        </RibbonMenu>
        <RibbonButton
          label="Clear filters"
          icon={<FilterX />}
          disabled={!active.length && 'No filters to clear'}
          onClick={() => taskView.setFilters(clearedFilters(filters))}
        />
      </Group>
      <Sep />
      <Group label="Views">
        <RibbonMenu label={current ? `Saved views: ${current.name}` : 'Saved views'} text="Saved views" icon={<Bookmark />} count={current ? 1 : 0}>
          {views.length ? (
            views.map((v) => (
              <MenuItem key={v.id} icon={v.shared ? <Users size={15} /> : <Bookmark size={15} />} checked={current?.id === v.id} onSelect={() => openView(v)}>
                {v.name}
              </MenuItem>
            ))
          ) : (
            <div className="muted small rb-menu-empty">No saved views yet. Filter All Tasks, then Save view.</div>
          )}
          {managed && (managed.ownerId === me || isAdmin) && (
            <>
              <MenuSeparator />
              <MenuLabel>{managed.name}</MenuLabel>
              <SavedViewActions v={managed} wsId={wsId} isCurrent={current?.id === managed.id} isAdmin={isAdmin} />
            </>
          )}
        </RibbonMenu>
        <RibbonButton
          label="Save view"

          icon={<BookmarkPlus />}
          disabled={!onAll ? 'Save view works in All Tasks' : current ? `Already saved as “${current.name}”` : false}
          title="Save these filters as a view"
          onClick={() => void saveCurrentView(wsId, setParams)}
        />
      </Group>
      {end}
    </RibbonFrame>
  );
}

// ───────────── Calendar ─────────────

function CalendarRibbon() {
  const [params, setParams] = useSearchParams();
  const canEdit = useCanEdit();
  const tags = useStore((s) => s.tags);
  const teams = useStore((s) => s.teams);
  const mode = calendarMode(params);
  const who = calendarWho(params);
  const tagIds = calendarTags(params);
  const team = calendarTeam(params);
  const cursor = calendarDate(params);
  const set = (fn: (p: URLSearchParams) => URLSearchParams | void) =>
    setParams(
      (p) => {
        fn(p);
        return p;
      },
      { replace: true },
    );
  const setParam = (k: string, v: string | null) => set((p) => (v ? p.set(k, v) : p.delete(k)));
  const toggleTag = (id: string) => {
    const next = tagIds.includes(id) ? tagIds.filter((x) => x !== id) : [...tagIds, id];
    setParam('tags', next.join(',') || null);
  };
  const unit = mode === 'week' ? 'week' : 'month';
  return (
    <RibbonFrame strip="New · Navigate · View · Filter" section>
      <Group label="New">
        <RibbonButton label="New task" text="New task" title="New task (Q)" icon={<Plus />} disabled={!canEdit && VIEWER} onClick={() => ui.openQuickAdd({})} />
      </Group>
      <Sep />
      <Group label="Navigate">
        <RibbonButton label="Go to today" text="Today" icon={<CalendarDays />} disabled={cursor === today() && 'Already showing today'} onClick={() => set((p) => setCalendarDate(p, today()))} />
        <RibbonButton label={`Previous ${unit}`} icon={<ChevronLeft />} onClick={() => set((p) => setCalendarDate(p, stepCalendar(cursor, mode, -1)))} />
        <RibbonButton label={`Next ${unit}`} icon={<ChevronRight />} onClick={() => set((p) => setCalendarDate(p, stepCalendar(cursor, mode, 1)))} />
      </Group>
      <Sep />
      <Group label="View">
        <RibbonButton label="Week" text="Week" icon={<CalendarRange />} active={mode === 'week'} onClick={() => set((p) => setCalendarMode(p, 'week'))} />
        <RibbonButton label="Month" text="Month" icon={<CalendarDays />} active={mode === 'month'} onClick={() => set((p) => setCalendarMode(p, 'month'))} />
      </Group>
      <Sep />
      <Group label="Filter">
        <RibbonButton label="Mine" text="Mine" icon={<User />} active={who === 'mine'} onClick={() => setParam('who', null)} />
        <RibbonButton label="Everyone" text="Everyone" icon={<Users />} active={who === 'all'} onClick={() => setParam('who', 'all')} />
        <RibbonMenu label="Tags filter" text="Tags" icon={<Tag />} count={tagIds.length}>
          {tags.length ? (
            tags.map((t) => (
              <MenuItem key={t.id} icon={<LabelDot color={t.color} />} checked={tagIds.includes(t.id)} keepOpen onSelect={() => toggleTag(t.id)}>
                {t.name}
              </MenuItem>
            ))
          ) : (
            <div className="muted small rb-menu-empty">No tags yet.</div>
          )}
          {tagIds.length > 0 && (
            <>
              <MenuSeparator />
              <MenuItem icon={<FilterX size={15} />} onSelect={() => setParam('tags', null)}>
                Remove Tags filter
              </MenuItem>
            </>
          )}
        </RibbonMenu>
        <RibbonMenu label="Team filter" text="Team" icon={<UsersRound />} count={team ? 1 : 0}>
          {teams.length ? (
            [...orderedTeams(teams).map((t) => ({ id: t.id, label: teamLabel(t, teams), icon: <LabelDot color={t.color} /> })), { id: 'none', label: 'No team', icon: null }].map((t) => (
              <MenuItem key={t.id} icon={t.icon} checked={team === t.id} onSelect={() => setParam('team', t.id)}>
                {t.label}
              </MenuItem>
            ))
          ) : (
            <div className="muted small rb-menu-empty">No teams yet. Owners and admins add them in Settings → Teams.</div>
          )}
          {team && (
            <>
              <MenuSeparator />
              <MenuItem icon={<FilterX size={15} />} onSelect={() => setParam('team', null)}>
                Remove Team filter
              </MenuItem>
            </>
          )}
        </RibbonMenu>
      </Group>
      {end}
    </RibbonFrame>
  );
}

// ───────────── Notes overview (no page open) ─────────────

function NotesRibbon({ wsId }: { wsId: string }) {
  const navigate = useNavigate();
  const canEdit = useCanEdit();
  const oneNote = useOneNoteEnabled();
  const tree = useStore((s) => s.tree);
  const sel = useNotesSelection(wsId);
  const sectionId = tree.sections.some((s) => s.id === sel.sectionId) ? sel.sectionId : (tree.sections[0]?.id ?? null);
  const notebook = tree.notebooks.find((n) => n.id === sel.notebookId) ?? tree.notebooks.find((n) => n.id === tree.sections.find((s) => s.id === sectionId)?.notebookId);
  const noSection = !sectionId && 'Create a notebook first';
  const createPage = async () => {
    if (!sectionId) return null;
    try {
      const { id } = await post<{ id: string }>(`/sections/${sectionId}/pages`, { title: '' });
      return id;
    } catch (e) {
      errorToast(e);
      return null;
    }
  };
  const newSection = async () => {
    if (!notebook) return;
    const name = (await promptDialog({ title: `New section in ${notebook.name}`, label: 'Name', confirmLabel: 'Create' }))?.trim();
    if (name) post(`/notebooks/${notebook.id}/sections`, { name }).catch(errorToast);
  };
  const importMarkdown = async () => {
    const files = await pickMarkdownFiles();
    if (!files.length) return;
    const id = await createPage();
    if (!id) return;
    setPendingImport(id, files);
    navigate(`/w/${wsId}/p/${id}`);
  };
  return (
    <RibbonFrame strip="New · Import" section>
      <Group label="New">
        <RibbonButton
          label="New page"
          text="New page"
          title="New page (N)"
          icon={<FilePlus />}
          disabled={!canEdit ? VIEWER : noSection}
          onClick={() => void createPage().then((id) => id && navigate(`/w/${wsId}/p/${id}`))}
        />
        <RibbonButton label="New section" text="New section" icon={<FolderPlus />} disabled={!canEdit ? VIEWER : !notebook && 'Create a notebook first'} onClick={() => void newSection()} />
        <RibbonButton label="New notebook" text="New notebook" icon={<BookPlus />} disabled={!canEdit && VIEWER} onClick={openNewNotebook} />
      </Group>
      <Sep />
      <Group label="Import">
        <RibbonMenu label="Import" text="Import" icon={<Upload />} disabled={!canEdit && VIEWER}>
          <MenuItem
            onSelect={() => {
              if (!oneNote) return toast('OneNote import isn’t set up on this server');
              navigate(`/w/${wsId}/settings?s=workspace`);
            }}
          >
            From OneNote…
          </MenuItem>
          <MenuItem onSelect={() => (sectionId ? void importMarkdown() : toast('Create a notebook first'))}>Markdown files…</MenuItem>
        </RibbonMenu>
      </Group>
      {end}
    </RibbonFrame>
  );
}

// ───────────── Settings ─────────────

function SettingsRibbon({ wsId }: { wsId: string }) {
  const navigate = useNavigate();
  return (
    <RibbonFrame strip="Navigate" section>
      <Group label="Navigate">
        <RibbonButton label="Back to notes" text="Back to notes" icon={<ArrowLeft />} onClick={() => navigate(viewTarget(wsId, 'notes'))} />
      </Group>
      {end}
    </RibbonFrame>
  );
}
