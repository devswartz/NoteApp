namespace Notivelo.Windows
{
    /// <summary>The app theme (Settings → Appearance, the account menu). System follows Windows' light / dark setting and shows as Light or Dark.</summary>
    public enum ThemeMode { Hybrid, Light, Dark, System }
}

namespace Notivelo.Windows.Data
{
    // PARITY batch 4 (tree and shell polish): plain records and the pure rules behind them (the unit tests compile this file without WinUI). The wording,
    // palettes and rules are Apple's (Shell/Menus.swift ColorRow, Look/Theme.swift AccentChoice, Shell/SettingsAccount.swift shortcuts, Dialogs.swift OfflineBanner).

    /// <summary>Who a notebook is shared with (the core's NotebookShares): private notebooks show only to their creator and <see cref="UserIds"/>.</summary>
    public sealed record NotebookSharesInfo(bool IsPrivate, string CreatedBy, IReadOnlyList<string> UserIds);

    /// <summary>One accent in one palette: the text/link colour, the solid fill, their hover colours and the inverse (on toasts). 0xRRGGBB.</summary>
    public sealed record AccentSet(uint Accent, uint Hover, uint Solid, uint SolidHover, uint Inverse);

    /// <summary>One of the web's eight accent colours (src/store/ui.ts ACCENTS, src/styles/accents.css): the swatch, a light set and a dark set.</summary>
    public sealed record AccentChoice(string Key, string Label, uint Swatch, AccentSet Light, AccentSet Dark);

    public static class ShellRules
    {
        // ---- theme ----

        /// <summary>System becomes Light or Dark by what Windows is set to; the others stay as they are.</summary>
        public static ThemeMode Resolve(ThemeMode mode, bool systemDark) => mode == ThemeMode.System ? (systemDark ? ThemeMode.Dark : ThemeMode.Light) : mode;

        public static string ThemeKey(ThemeMode m) => m.ToString().ToLowerInvariant();

        public static ThemeMode ParseTheme(string? text, ThemeMode fallback) => Enum.TryParse<ThemeMode>(text, true, out var m) ? m : fallback;

        // ---- accent ----

        public static readonly IReadOnlyList<AccentChoice> Accents = new[]
        {
            new AccentChoice("blue", "Blue", 0x4F46E5, new(0x4F46E5, 0x4338CA, 0x4F46E5, 0x4338CA, 0xA5B4FC), new(0x8B95F9, 0xA5B4FC, 0x5B5BD6, 0x4B4BC4, 0x4F46E5)),
            new AccentChoice("purple", "Purple", 0x9333EA, new(0x7E22CE, 0x6B21A8, 0x7E22CE, 0x6B21A8, 0xC084FC), new(0xC084FC, 0xD8B4FE, 0x9333EA, 0x7E22CE, 0x7E22CE)),
            new AccentChoice("teal", "Teal", 0x0D9488, new(0x0D6D65, 0x115E59, 0x0D6D65, 0x115E59, 0x2DD4BF), new(0x2DD4BF, 0x5EEAD4, 0x0F766E, 0x115E59, 0x0D6D65)),
            new AccentChoice("green", "Green", 0x16A34A, new(0x13733A, 0x166534, 0x13733A, 0x166534, 0x4ADE80), new(0x4ADE80, 0x86EFAC, 0x15803D, 0x166534, 0x13733A)),
            new AccentChoice("orange", "Orange", 0xEA580C, new(0xB53D0B, 0x9A3412, 0xB53D0B, 0x9A3412, 0xFB923C), new(0xFB923C, 0xFDBA74, 0xC2410C, 0x9A3412, 0xB53D0B)),
            new AccentChoice("red", "Red", 0xDC2626, new(0xB91C1C, 0x991B1B, 0xB91C1C, 0x991B1B, 0xFB8585), new(0xFB8585, 0xFCA5A5, 0xB91C1C, 0x991B1B, 0xB91C1C)),
            new AccentChoice("pink", "Pink", 0xDB2777, new(0xBE185D, 0x9D174D, 0xBE185D, 0x9D174D, 0xF472B6), new(0xF472B6, 0xF9A8D4, 0xBE185D, 0x9D174D, 0xBE185D)),
            new AccentChoice("graphite", "Graphite", 0x52525B, new(0x3F3F46, 0x27272A, 0x3F3F46, 0x27272A, 0xA1A1AA), new(0xA1A1AA, 0xD4D4D8, 0x52525B, 0x3F3F46, 0x3F3F46)),
        };

        public static AccentChoice AccentOf(string? key) => Accents.FirstOrDefault(a => a.Key.Equals(key, StringComparison.OrdinalIgnoreCase)) ?? Accents[0];

        /// <summary>The alpha of --accent-soft (and the selected row) over the accent: 10 % on light surfaces, 15 % on dark.</summary>
        public static byte SoftAlpha(bool dark) => (byte)(dark ? 0x26 : 0x1A);

        /// <summary>The solid fill of a disabled accent button: the solid colour at 45 % over the surface (white or the dark base).</summary>
        public static uint DisabledSolid(uint solid, bool dark)
        {
            var bg = dark ? 0x1C1C20u : 0xFFFFFFu;
            uint Mix(int shift) { var a = (solid >> shift) & 0xFF; var b = (bg >> shift) & 0xFF; return (uint)Math.Round(a * 0.45 + b * 0.55) & 0xFF; }
            return (Mix(16) << 16) | (Mix(8) << 8) | Mix(0);
        }

        // ---- section and notebook colours (Apple ColorRow.colors, #rrggbb) ----

        public static readonly IReadOnlyList<(string Hex, string Name)> TreeColours = new[]
        {
            ("#6366f1", "Indigo"), ("#0ea5e9", "Sky"), ("#10b981", "Green"), ("#f59e0b", "Amber"), ("#ef4444", "Red"), ("#ec4899", "Pink"), ("#8b5cf6", "Violet"), ("#64748b", "Slate"),
        };

        public static bool SameColour(string? a, string? b) => a is not null && b is not null && a.Equals(b, StringComparison.OrdinalIgnoreCase);

        public static string ColourName(string? hex) => TreeColours.FirstOrDefault(c => SameColour(c.Hex, hex)).Name ?? "Custom";

        // ---- the tree: where a drop or a Move up / Move down puts an item ----

        /// <summary>The index to give a move for a drop next to <paramref name="targetId"/> (the core's drop_index / the web's indexFor). <paramref name="siblings"/> are the
        /// new siblings in order, without the item being moved. <paramref name="after"/>: the drop is below the target. A target that is not among them gives the end.</summary>
        public static int DropIndex(IReadOnlyList<string> siblings, string targetId, bool after)
        {
            var i = siblings.ToList().IndexOf(targetId);
            return i < 0 ? siblings.Count : after ? i + 1 : i;
        }

        /// <summary>Where a row's pointer is: the top quarter drops before it, the bottom quarter after it, the middle into it (when it can hold the item).</summary>
        public enum Zone { Before, Into, After }

        public static Zone DropZone(double y, double height, bool canNest)
        {
            if (height <= 0) return Zone.After;
            var f = y / height;
            if (!canNest) return f < 0.5 ? Zone.Before : Zone.After;
            return f < 0.28 ? Zone.Before : f > 0.72 ? Zone.After : Zone.Into;
        }

        /// <summary>The index of an item among its siblings after one step up (-1) or down (+1), counted without the item itself (what a move call takes), or null at the end.</summary>
        public static int? StepIndex(IReadOnlyList<string> siblings, string id, int step)
        {
            var i = siblings.ToList().IndexOf(id);
            if (i < 0) return null;
            var to = i + step;
            return to < 0 || to >= siblings.Count ? null : to;
        }

        /// <summary>The same move in memory: take <paramref name="id"/> out of the list and put it at <paramref name="index"/> (null or past the end: last).</summary>
        public static List<T> Reorder<T>(IEnumerable<T> list, Func<T, bool> isIt, int? index)
        {
            var all = list.ToList();
            var item = all.FirstOrDefault(isIt);
            if (item is null) return all;
            all.RemoveAll(x => isIt(x));
            var at = index is null ? all.Count : Math.Clamp(index.Value, 0, all.Count);
            all.Insert(at, item);
            return all;
        }

        // ---- offline pill (Apple's OfflineBanner: after 30 s without a connection, dismissed until the next reconnect) ----

        public static readonly TimeSpan OfflineAfter = TimeSpan.FromSeconds(30);
        public const string OfflineText = "Offline. Changes sync when you reconnect.";

        public static bool ShowOfflinePill(DateTime? offlineSince, DateTime now, bool dismissed, bool immediate = false) =>
            offlineSince is not null && !dismissed && (immediate || now - offlineSince.Value >= OfflineAfter);

        // ---- page title ----

        /// <summary>The title to save after an edit, or null when nothing changes (the same text, or only spaces added).</summary>
        public static string? TitleChange(string current, string typed)
        {
            var t = typed.Trim();
            var c = current == "Untitled" ? "" : current.Trim();
            return t == c ? null : t;
        }

        // ---- keyboard shortcuts (the sheet; Windows keys) ----

        public sealed record Shortcut(string Title, string[] Keys);
        public sealed record ShortcutGroup(string Title, IReadOnlyList<Shortcut> Items);

        public static readonly IReadOnlyList<ShortcutGroup> Shortcuts = new[]
        {
            new ShortcutGroup("General", new Shortcut[]
            {
                new("Search", new[] { "Ctrl", "K" }),
                new("Search (alternative)", new[] { "Ctrl", "Shift", "F" }),
                new("New task", new[] { "Q" }),
                new("New page", new[] { "Ctrl", "N" }),
                new("New task (quick add)", new[] { "Ctrl", "Shift", "T" }),
                new("Settings", new[] { "Ctrl", "," }),
                new("Keyboard shortcuts", new[] { "Ctrl", "/" }),
                new("Close a dialog or menu", new[] { "Esc" }),
            }),
            new ShortcutGroup("Go to", new Shortcut[]
            {
                new("Today", new[] { "Ctrl", "1" }),
                new("Upcoming", new[] { "Ctrl", "2" }),
                new("My Tasks", new[] { "Ctrl", "3" }),
                new("Team", new[] { "Ctrl", "4" }),
                new("All tasks", new[] { "Ctrl", "5" }),
                new("Calendar", new[] { "Ctrl", "6" }),
                new("Notes", new[] { "Ctrl", "8" }),
            }),
            new ShortcutGroup("Text formatting", new Shortcut[]
            {
                new("Bold", new[] { "Ctrl", "B" }),
                new("Italic", new[] { "Ctrl", "I" }),
                new("Underline", new[] { "Ctrl", "U" }),
                new("Strikethrough", new[] { "Ctrl", "Shift", "X" }),
                new("Link", new[] { "Ctrl", "K" }),
            }),
            new ShortcutGroup("In a page", new Shortcut[]
            {
                new("Insert block menu", new[] { "/" }),
                new("Make a task of the line", new[] { "Ctrl", "Enter" }),
                new("Undo", new[] { "Ctrl", "Z" }),
                new("Redo", new[] { "Ctrl", "Y" }),
            }),
        };

        /// <summary>The sheet's keys: Ctrl+/ (or Ctrl+? ) anywhere, and a bare ? when no text field has the keyboard.</summary>
        public static bool OpensShortcuts(bool ctrl, bool shift, bool textFocused, string key) =>
            (ctrl && key == "/") || (!ctrl && !textFocused && key == "?");
    }
}
