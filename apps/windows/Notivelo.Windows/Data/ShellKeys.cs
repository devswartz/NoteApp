namespace Notivelo.Windows.Data;

/// <summary>What an app-menu shortcut does (the Mac app's menu.rs, the web's DESKTOP_SHORTCUTS): the keys that stand in for the menu bar Windows has not got.</summary>
public enum ShellKey { None, NewPage, NewTask, Today, Upcoming, MyTasks, Team, AllTasks, Calendar, Notes, Settings }

/// <summary>Pure rules for the shell's shortcuts (no WinUI: the unit tests compile this file).</summary>
public static class ShellKeys
{
    /// <summary>Ctrl+N new page, Ctrl+Shift+T new task, Ctrl+1 Today, 2 Upcoming, 3 My Tasks, 4 Team, 5 All tasks, 6 Calendar, 8 Notes (7 is not used, as on the Mac), Ctrl+, Settings.
    /// <paramref name="vk"/> is a virtual-key code (letters and digits as their capitals, the number pad 0x60-0x69, comma 0xBC).</summary>
    public static ShellKey Of(bool ctrl, bool shift, bool alt, int vk)
    {
        if (!ctrl || alt) return ShellKey.None;
        if (shift) return vk == 0x54 ? ShellKey.NewTask : ShellKey.None;
        var digit = vk is >= 0x31 and <= 0x39 ? vk - 0x30 : vk is >= 0x61 and <= 0x69 ? vk - 0x60 : -1;
        return digit switch
        {
            1 => ShellKey.Today, 2 => ShellKey.Upcoming, 3 => ShellKey.MyTasks, 4 => ShellKey.Team, 5 => ShellKey.AllTasks, 6 => ShellKey.Calendar, 8 => ShellKey.Notes,
            _ => vk switch { 0x4E => ShellKey.NewPage, 0xBC => ShellKey.Settings, _ => ShellKey.None },
        };
    }

    /// <summary>Where Ctrl+N puts the new page (the web's newPage): the section of the page that is open, else the first section of the notebook that is shown, else the first section there is.
    /// Null when there is no section at all.</summary>
    public static string? SectionForNewPage(IReadOnlyList<Notebook> notebooks, string? currentNotebookId, string? openPageId)
    {
        static Section? Find(IReadOnlyList<Section> list, string page)
        {
            foreach (var s in list)
            {
                if (s.Pages.Any(p => p.Id == page)) return s;
                if (Find(s.Children, page) is { } hit) return hit;
            }
            return null;
        }
        if (openPageId is not null)
            foreach (var n in notebooks) if (Find(n.Sections, openPageId) is { } s) return s.Id;
        var nb = notebooks.FirstOrDefault(n => n.Id == currentNotebookId && n.Sections.Count > 0) ?? notebooks.FirstOrDefault(n => n.Sections.Count > 0);
        return nb?.Sections[0].Id;
    }
}
