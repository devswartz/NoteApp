// The app shell's own commands: navigation, creation, layout and theme.
// Other areas register theirs with useCommands() from src/hooks/useShortcuts.ts.
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  BookPlus,
  FilePlus,
  Inbox,
  Keyboard,
  ListChecks,
  MessageSquare,
  NotebookText,
  PanelLeft,
  Plus,
  Printer,
  Search,
  Settings,
  SunMoon,
  Sun,
  Users,
} from 'lucide-react';
import { post } from '../../api.ts';
import { canEditWorkspace, errorToast, toast, ui, useStore } from '../../store.ts';
import { cycleTheme } from '../../store/ui.ts';
import { useCommands, type Command } from '../../hooks/useShortcuts.ts';
import { openNewNotebook } from './NewNotebookDialog.tsx';
import { openFeedback } from './FeedbackDialog.tsx';
import { useRibbon } from '../../editor/ribbonState.ts';

const currentPageId = () => location.pathname.match(/\/p\/([^/?#]+)/)?.[1];

export function useShellCommands(wsId: string) {
  const navigate = useNavigate();

  useCommands(() => {
    const go = (path: string) => () => navigate(`/w/${wsId}/${path}`);
    const nav = (id: string, title: string, key: string, path: string, icon: React.ReactNode): Command => ({
      id: `nav.${id}`,
      title: `Go to ${title}`,
      group: 'Navigation',
      keys: `g ${key}`,
      icon,
      run: go(path),
    });

    const newPage = async () => {
      const s = useStore.getState();
      const pid = currentPageId();
      const current = pid ? s.tree.pages.find((p) => p.id === pid) : undefined;
      const sectionId = current?.sectionId ?? s.tree.sections[0]?.id;
      if (!sectionId) return toast('Create a notebook first');
      try {
        const { id } = await post<{ id: string }>(`/sections/${sectionId}/pages`, { title: '' });
        navigate(`/w/${wsId}/p/${id}`);
      } catch (err) {
        errorToast(err);
      }
    };

    return [
      {
        id: 'app.palette',
        title: 'Search or run a command',
        group: 'General',
        keys: 'mod+k',
        icon: <Search size={16} />,
        global: true,
        palette: false,
        run: () => (useStore.getState().paletteOpen ? ui.closePalette() : ui.openPalette()),
      },
      { id: 'app.shortcuts', title: 'Keyboard shortcuts', group: 'General', keys: '?', icon: <Keyboard size={16} />, run: () => ui.setShortcuts(true) },
      { id: 'app.feedback', title: 'Send feedback', group: 'General', keywords: 'bug idea suggestion report problem help contact', icon: <MessageSquare size={16} />, run: openFeedback },
      { id: 'app.sidebar', title: 'Toggle sidebar', group: 'General', keys: 'mod+\\', icon: <PanelLeft size={16} />, run: ui.toggleSidebar },
      { id: 'app.theme', title: 'Switch theme (light / dark / system)', group: 'General', keywords: 'dark mode appearance', icon: <SunMoon size={16} />, run: cycleTheme },
      {
        id: 'tasks.new',
        title: 'New task',
        group: 'Create',
        keys: 'q',
        keywords: 'add todo quick',
        icon: <Plus size={16} />,
        when: canEditWorkspace,
        run: () => {
          const pageId = currentPageId();
          ui.openQuickAdd(pageId ? { pageId } : {});
        },
      },
      { id: 'notebooks.new', title: 'New notebook…', group: 'Create', keywords: 'template project personal meetings', icon: <BookPlus size={16} />, when: canEditWorkspace, run: openNewNotebook },
      {
        id: 'page.print',
        title: 'Print page…',
        group: 'Notes',
        keys: 'mod+p',
        keywords: 'pdf save paper',
        icon: <Printer size={16} />,
        allowInInput: true,
        // Only on an open page: elsewhere the browser prints the view as usual.
        when: () => !!useRibbon.getState().page,
        run: () => void import('../../print/print.ts').then((m) => m.printWithChoice()),
      },
      { id: 'pages.new', title: 'New page', group: 'Create', keys: 'n', keywords: 'note canvas', icon: <FilePlus size={16} />, when: canEditWorkspace, run: () => newPage() },
      nav('today', 'Today', 't', 'tasks/today', <Sun size={16} />),
      nav('my', 'My Tasks', 'm', 'tasks/my', <Inbox size={16} />),
      nav('upcoming', 'Upcoming', 'u', 'tasks/upcoming', <CalendarRange size={16} />),
      nav('team', 'Team', 'e', 'tasks/team', <Users size={16} />),
      nav('all', 'All Tasks', 'a', 'tasks/all', <ListChecks size={16} />),
      nav('calendar', 'Calendar', 'c', 'tasks/calendar', <CalendarDays size={16} />),
      nav('completed', 'Completed', 'd', 'tasks/completed', <CheckCircle2 size={16} />),
      nav('notes', 'Notes', 'n', 'notes', <NotebookText size={16} />),
      nav('activity', 'Activity', 'v', 'activity', <Activity size={16} />),
      nav('settings', 'Settings', 's', 'settings', <Settings size={16} />),
    ];
  }, [wsId, navigate]);

  // Help-only entries for shortcuts the editor handles itself (the Editor area can
  // replace these by registering the same ids with its own commands).
  useCommands(
    () =>
      (
        [
          ['editor.slash', 'Insert block menu', '/'],
          ['editor.taskItem', 'New task', '/ task'],
          ['editor.toTask', 'Turn line into task', 'mod+enter'],
          ['editor.bold', 'Bold', 'mod+b'],
          ['editor.italic', 'Italic', 'mod+i'],
          ['editor.underline', 'Underline', 'mod+u'],
          ['editor.heading', 'Heading 1–3', '# space'],
          ['editor.undo', 'Undo', 'mod+z'],
          ['editor.redo', 'Redo', 'mod+shift+z'],
        ] as const
      ).map(([id, title, keys]) => ({ id, title, keys, group: 'In a note', palette: false })),
    [],
  );
}
