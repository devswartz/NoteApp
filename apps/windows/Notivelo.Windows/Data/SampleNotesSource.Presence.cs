namespace Notivelo.Windows.Data;

// One fake viewer on every page of the sample, so the page bar's avatar stack and the "On this page now" list can be seen and tested without a server.
public sealed partial class SampleNotesSource
{
    private static readonly PagePerson[] SampleViewer = { new("u-viewer", "Sample Viewer", "#0ea5e9", false, 1) };

    public IReadOnlyList<PagePerson> PagePeople(string pageId) => SampleViewer;
}
