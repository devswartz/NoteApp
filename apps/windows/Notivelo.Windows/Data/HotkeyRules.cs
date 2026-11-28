namespace Notivelo.Windows.Data;

/// <summary>A global shortcut: Win32 modifier flags (MOD_ALT 1, MOD_CONTROL 2, MOD_SHIFT 4, MOD_WIN 8) and a virtual-key code.</summary>
public readonly record struct Hotkey(uint Modifiers, uint Vk);

/// <summary>The door to Win32's RegisterHotKey, so the registration rules can be tested with a fake.</summary>
public interface IHotkeyApi
{
    /// <summary>Register; false when it failed, with the Win32 error (1409 = ERROR_HOTKEY_ALREADY_REGISTERED: another app has it).</summary>
    bool Register(int id, Hotkey key, out int error);
    void Unregister(int id);
}

public enum HotkeyState { NotRegistered, Registered, Taken, Failed, Invalid }

/// <summary>Parsing and registering the global quick-capture shortcut (the Tauri app's <c>quick.rs</c>: Alt+CmdOrCtrl+N, so Ctrl+Alt+N on Windows). Another app may own it: that is reported,
/// never thrown, and the tray menu's Quick Capture still works.</summary>
public sealed class HotkeyService
{
    public const string QuickCapture = "Ctrl+Alt+N";
    public const int Id = 1;
    private const int ErrorAlreadyRegistered = 1409;
    private const uint NoRepeat = 0x4000;

    private readonly IHotkeyApi _api;
    private readonly string _text;
    public HotkeyState State { get; private set; } = HotkeyState.NotRegistered;

    public HotkeyService(IHotkeyApi api, string text = QuickCapture) { _api = api; _text = text; }

    /// <summary>Why the shortcut is off, in a sentence for the user; null when it works.</summary>
    public string? Problem => State switch
    {
        HotkeyState.Taken => $"{_text} is used by another app, so the quick capture shortcut is off. Use Quick Capture in the tray menu.",
        HotkeyState.Failed or HotkeyState.Invalid => $"The quick capture shortcut {_text} could not be set. Use Quick Capture in the tray menu.",
        _ => null,
    };

    /// <summary>Win32 modifiers and key of "Ctrl+Alt+N" (also Tauri's "Alt+CmdOrCtrl+N", "Shift+F9"): at least one modifier and exactly one key (A-Z, 0-9, F1-F12). Null otherwise.</summary>
    public static Hotkey? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        uint mods = 0; uint? vk = null;
        foreach (var raw in text.Split('+', StringSplitOptions.TrimEntries))
        {
            switch (raw.ToLowerInvariant())
            {
                case "ctrl" or "control" or "cmdorctrl" or "commandorcontrol": mods |= 2; continue;
                case "alt" or "option": mods |= 1; continue;
                case "shift": mods |= 4; continue;
                case "win" or "super" or "meta": mods |= 8; continue;
                case "": return null;
            }
            if (vk is not null) return null;
            if (raw.Length == 1 && char.IsAsciiLetterOrDigit(raw[0])) vk = char.ToUpperInvariant(raw[0]);
            else if (raw.Length is 2 or 3 && (raw[0] is 'F' or 'f') && int.TryParse(raw.AsSpan(1), out var f) && f is >= 1 and <= 12) vk = (uint)(0x6F + f);
            else return null;
        }
        return mods != 0 && vk is { } k ? new Hotkey(mods, k) : null;
    }

    /// <summary>Register the shortcut. Safe to call again (it drops its own earlier registration first).</summary>
    public HotkeyState Register()
    {
        Unregister();
        if (Parse(_text) is not { } key) return State = HotkeyState.Invalid;
        bool ok; int error;
        try { ok = _api.Register(Id, key with { Modifiers = key.Modifiers | NoRepeat }, out error); }
        catch (Exception) { return State = HotkeyState.Failed; }
        return State = ok ? HotkeyState.Registered : error == ErrorAlreadyRegistered ? HotkeyState.Taken : HotkeyState.Failed;
    }

    public void Unregister()
    {
        if (State != HotkeyState.Registered) return;
        try { _api.Unregister(Id); } catch (Exception) { }
        State = HotkeyState.NotRegistered;
    }

    /// <summary>A WM_HOTKEY with this id is ours.</summary>
    public bool Owns(int id) => State == HotkeyState.Registered && id == Id;
}

/// <summary>Quick capture's modes: Tab switches between a task and a page.</summary>
public enum QuickMode { Task, Note }

/// <summary>Quick capture's words (the web's <c>quickCapture.tsx</c> and <c>captureErrors.ts</c>): Tab switches between a task and a page, Enter adds, Esc closes.</summary>
public static class QuickCaptureRules
{
    public static QuickMode Toggle(QuickMode m) => m == QuickMode.Task ? QuickMode.Note : QuickMode.Task;
    public static string Placeholder(QuickMode m) => m == QuickMode.Task ? "Add a task: “Send invoice tomorrow p1”" : "New page title";
    public static string Label(QuickMode m) => m == QuickMode.Task ? "New task" : "New page";
    public static string Name(QuickMode m) => m == QuickMode.Task ? "Task" : "Page";
    public static string Other(QuickMode m) => m == QuickMode.Task ? "page" : "task";
    public const string SignedOut = "Sign in to the app first. ↵ opens it.";
    public const string Offline = "You’re offline. Your text is kept; try again when you’re connected.";
    public const string NoNotebook = "Create a notebook in the app first.";

    /// <summary>The state a UI test reads from the capture window: <c>mode=task;busy=0;signedout=0</c>.</summary>
    public static string Readout(QuickMode m, bool busy, bool signedOut) => $"mode={(m == QuickMode.Task ? "task" : "note")};busy={(busy ? 1 : 0)};signedout={(signedOut ? 1 : 0)}";
}
