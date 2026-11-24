using FlaUI.Core.AutomationElements;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>PARITY batch 2 on the offline sample (no server): a comment on selected text, lock and unlock a page, version history, the page icon, sharing,
/// Markdown export and "Shared with me". Driven through UI Automation (ids the app names) and a few real keys. Run on the CI runner only.</summary>
public class PageToolsTests
{
    private static AutomationElement Find(AppHost h, string id, int ms = 20000) =>
        AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)), "element " + id, ms);

    private static bool Gone(AppHost h, string id) => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)) is null;

    private static void Retry(Action a)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            try { a(); return; }
            catch (Exception) when (sw.ElapsedMilliseconds < 15000) { Thread.Sleep(200); }
        }
    }

    // tree rows have no Invoke pattern: click those
    private static void Invoke(AppHost h, string id) => Retry(() =>
    {
        var e = Find(h, id);
        if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke();
        else { e.Click(); Thread.Sleep(250); }
    });
    private static void SetText(AppHost h, string id, string text) => Retry(() => Find(h, id).AsTextBox().Text = text);
    private static string Status(AppHost h, string id) => Find(h, id).Properties.ItemStatus.ValueOrDefault ?? "";
    private static string Log(AppHost h) => File.Exists(h.TaskLog) ? File.ReadAllText(h.TaskLog) : "";

    private static void PageMenu(AppHost h, string item) { Invoke(h, "page-options"); Invoke(h, item); }

    private static void WaitStatus(AppHost h, string id, string part) =>
        AppHost.Wait(() => Status(h, id).Contains(part) ? "x" : null, $"{id} to report {part}");

    [Fact]
    public void Comment_on_selected_text_starts_a_thread() => AppHost.Run(nameof(Comment_on_selected_text_starts_a_thread), h =>
    {
        h.A.Focus();
        h.Type("Check this line");
        h.Chord(LCONTROL, KEY_A);
        Invoke(h, "float-comment");
        Find(h, "comment-composer");
        SetText(h, "comment-input", "Looks good to me");
        Invoke(h, "comment-submit");
        WaitStatus(h, "comments-panel", "threads=1");
        Assert.Contains("comment add Looks good to me", Log(h));
        WaitStatus(h, "page-comments-button", "open=1");
    });

    [Fact]
    public void Reply_and_resolve_a_seeded_thread() => AppHost.Run(nameof(Reply_and_resolve_a_seeded_thread), h =>
    {
        Invoke(h, "page-row-canvas");
        Invoke(h, "page-comments-button");
        WaitStatus(h, "comments-panel", "open=1");
        Invoke(h, "thread-resolve-th-canvas-1");
        WaitStatus(h, "comments-panel", "open=0");
        Assert.Contains("comment resolve th-canvas-1", Log(h));
    });

    [Fact]
    public void Lock_a_page_then_unlock_it_with_the_password() => AppHost.Run(nameof(Lock_a_page_then_unlock_it_with_the_password), h =>
    {
        PageMenu(h, "menu-lock-page");
        Find(h, "lock-dialog");
        h.Type("secret1"); h.Press(TAB); h.Type("secret1");          // the first field has the focus; no password was set yet
        AppHost.Wait(() => Find(h, "lock-ok").IsEnabled ? "x" : null, "Lock page enabled");
        Invoke(h, "lock-ok");
        AppHost.Wait(() => Gone(h, "lock-dialog") ? "x" : null, "the dialog closed");
        Assert.Contains("lock uitest", Log(h));
        PageMenu(h, "menu-lock-now");                                // the page shuts: the password prompt stands in for it
        Find(h, "locked-page");
        h.Type("wrongpass"); h.Press(ENTER);
        Find(h, "unlock-error");
        h.Type("secret1"); h.Press(ENTER);
        AppHost.Wait(() => Gone(h, "locked-page") ? "x" : null, "the page opened again");
        Assert.Contains("unlock", Log(h));
    });

    [Fact]
    public void Version_history_lists_previews_and_restores() => AppHost.Run(nameof(Version_history_lists_previews_and_restores), h =>
    {
        PageMenu(h, "menu-version-history");
        WaitStatus(h, "version-dialog", "versions=3");
        AppHost.Wait(() => Find(h, "version-restore").IsEnabled ? "x" : null, "a version previewed");
        Invoke(h, "version-restore");
        AppHost.Wait(() => Gone(h, "version-dialog") ? "x" : null, "the dialog closed");
        Assert.Contains("version restore", Log(h));
    });

    [Fact]
    public void Pick_a_page_icon() => AppHost.Run(nameof(Pick_a_page_icon), h =>
    {
        PageMenu(h, "menu-page-icon");
        Find(h, "icon-picker");
        Invoke(h, "icon-pick-0");
        WaitStatus(h, "page-icon", "icon=\U0001F4C4");
        Assert.Contains("icon \U0001F4C4", Log(h));
        Invoke(h, "page-icon");                                      // the icon itself opens the picker again, now with Remove
        Invoke(h, "icon-remove");
        AppHost.Wait(() => Gone(h, "page-icon") ? "x" : null, "the icon removed");
    });

    [Fact]
    public void Share_a_page_with_a_member() => AppHost.Run(nameof(Share_a_page_with_a_member), h =>
    {
        Invoke(h, "page-share");
        WaitStatus(h, "share-dialog", "shares=0");
        SetText(h, "share-input", "Sam");
        Invoke(h, "share-suggest-u2");
        WaitStatus(h, "share-dialog", "shares=1");
        Find(h, "share-remove-u2");
        Invoke(h, "share-remove-u2");
        WaitStatus(h, "share-dialog", "shares=0");
        Invoke(h, "share-done");
    });

    [Fact]
    public void Export_writes_a_markdown_file()
    {
        var path = Path.Combine(Path.GetTempPath(), "notivelo-export-" + Guid.NewGuid().ToString("N") + ".md");
        using var h = AppHost.Launch(new Dictionary<string, string> { ["NOTIVELO_TEST_SAVE"] = path });
        PageMenu(h, "menu-export-markdown");
        AppHost.Wait(() => File.Exists(path) ? "x" : null, "the exported file");
        var text = File.ReadAllText(path);
        Assert.StartsWith("# UI test", text);
        Assert.Contains("Second box", text);
        File.Delete(path);
    }

    [Fact]
    public void Shared_with_me_lists_a_page_and_removes_it() => AppHost.Run(nameof(Shared_with_me_lists_a_page_and_removes_it), h =>
    {
        Find(h, "sidebar-shared");
        Invoke(h, "shared-row-shared-q4");
        Find(h, "page-share");
        Invoke(h, "shared-remove-shared-q4");
        AppHost.Wait(() => Gone(h, "shared-row-shared-q4") ? "x" : null, "the page gone from Shared with me");
    });
}
