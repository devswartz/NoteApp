using Notivelo.Windows.Text;
using DT = global::Windows.ApplicationModel.DataTransfer;

namespace Notivelo.Windows.Controls;

/// <summary>The box clipboard on the Windows clipboard (Apple's PasteboardBoxes): the clip under the custom format <see cref="BoxClipboardRules.Format"/> next to its plain
/// text, and kept here too, so a paste still works when the clipboard can't be read (and a text copy made elsewhere since wins over this clip).</summary>
internal static class BoxClipboard
{
    private static string? _app;

    /// <summary>The last clip this app copied, whatever the system clipboard holds now (the offline UI tests read it back).</summary>
    public static string? Last => _app;

    public static void Set(string clipJson)
    {
        _app = clipJson;
        try
        {
            var pack = new DT.DataPackage { RequestedOperation = DT.DataPackageOperation.Copy };
            pack.SetText(BoxClipboardRules.PlainText(clipJson));
            pack.SetData(BoxClipboardRules.Format, clipJson);
            DT.Clipboard.SetContent(pack);
            DT.Clipboard.Flush();
        }
        catch (Exception) { /* the clipboard is busy or unavailable: the app's own copy still pastes */ }
    }

    public static async Task<string?> GetAsync()
    {
        string? sys = null, text = null;
        try
        {
            var view = DT.Clipboard.GetContent();
            if (view.Contains(BoxClipboardRules.Format)) sys = await view.GetDataAsync(BoxClipboardRules.Format) as string;
            if (view.Contains(DT.StandardDataFormats.Text)) text = await view.GetTextAsync();
        }
        catch (Exception) { return BoxClipboardRules.IsClip(_app) ? _app : null; }
        return BoxClipboardRules.Choose(sys, text, _app);
    }
}
