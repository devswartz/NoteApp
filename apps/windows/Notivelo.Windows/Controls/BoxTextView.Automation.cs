using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
using N = Notivelo.Native;

namespace Notivelo.Windows.Controls;

/// <summary>
/// UI Automation for a box: an Edit element (automation id <c>box-box-&lt;id&gt;</c>, set by the page) whose Value pattern is the box's
/// view text, read from the last render. The selection, focus, the open menu and undo state ride along in ItemStatus
/// (<c>block=paragraph;sel=A,H;focus=1;menu=slash:2/9;undo=1;redo=0;link=href;images=loaded;files=a.pdf;node=none;upload=0</c>): a test-only readout for the UI tests. A real Text pattern (ranges, caret,
/// IME-friendly) is the accessibility work still to do.
/// </summary>
internal sealed partial class BoxTextView
{
    protected override AutomationPeer OnCreateAutomationPeer() => new BoxTextViewPeer(this);

    internal string AutomationText => _r?.View.Text ?? "";

    internal string AutomationState
    {
        get
        {
            var r = _r;
            if (r is null) return "closed";
            var sel = r.View.Selection;
            var menu = r.Suggestion is { } s ? $"{s.Trigger.ToString().ToLowerInvariant()}:{s.Highlighted ?? 0}/{s.Items.Length}" : "none";
            var line = r.View.Lines.LastOrDefault(l => l.Offset <= sel.Head) ?? r.View.Lines.FirstOrDefault();
            var block = line is null ? "none" : line.Kind + (line.Marker is { Length: > 0 } m ? "/" + m : "");
            return $"block={block};sel={sel.Anchor},{sel.Head};focus={(_focused ? 1 : 0)};menu={menu};undo={(r.CanUndo ? 1 : 0)};redo={(r.CanRedo ? 1 : 0)};marked={(r.View.Marked is not null ? 1 : 0)};editor={(LinkEditorOpen ? 1 : 0)};link={(HrefAt((int)sel.Head - 1) ?? HrefAt((int)sel.Head) ?? "").Replace(";", "%3B")};{MediaState()}";
        }
    }
}

internal sealed class BoxTextViewPeer : FrameworkElementAutomationPeer, IValueProvider
{
    private readonly BoxTextView _box;
    public BoxTextViewPeer(BoxTextView owner) : base(owner) { _box = owner; }

    protected override string GetClassNameCore() => "BoxTextView";
    protected override AutomationControlType GetAutomationControlTypeCore() => AutomationControlType.Edit;
    protected override bool IsControlElementCore() => true;
    protected override bool IsContentElementCore() => true;
    protected override string GetItemStatusCore() => _box.AutomationState;
    protected override object GetPatternCore(PatternInterface patternInterface) =>
        patternInterface == PatternInterface.Value ? this : base.GetPatternCore(patternInterface);

    public bool IsReadOnly => true;
    public string Value => _box.AutomationText;
    public void SetValue(string value) { }
}
