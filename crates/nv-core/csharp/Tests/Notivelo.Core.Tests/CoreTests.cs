// The Core API from C# on corpus pages: proves nv_core.dll loads and the bindings work.
// Run with NV_CORPUS_DIR pointing at the repo's tests/corpus (CI: .github/workflows/windows-core.yml).
using System.Linq;
using System.Text.Json;
using Notivelo.Native;
using Xunit;

public class CoreTests
{
    private static string Corpus(string name, string file)
    {
        var dir = System.Environment.GetEnvironmentVariable("NV_CORPUS_DIR")
            ?? throw new System.InvalidOperationException("NV_CORPUS_DIR is not set");
        return System.IO.Path.Combine(dir, "cases", name, file);
    }

    private static byte[] Page(string name) => System.IO.File.ReadAllBytes(Corpus(name, "page.bin"));

    [Fact]
    public void CoreVersionIsNotEmpty()
    {
        Assert.False(string.IsNullOrEmpty(NvCore.CoreVersion()));
        Assert.Equal(2u, NvCore.PageFormatVersion());
    }

    [Fact]
    public void ReadsADocumentPage()
    {
        var info = NvCore.ReadPage(Page("document-page"));
        using var expected = JsonDocument.Parse(System.IO.File.ReadAllText(Corpus("document-page", "expected.json")));
        var root = expected.RootElement;
        Assert.Equal(root.GetProperty("kind").GetString(), info.Kind.ToString().ToLowerInvariant());
        Assert.Equal(root.GetProperty("newerFormat").GetBoolean(), info.NewerFormat);
        Assert.Equal(System.IO.File.ReadAllText(Corpus("document-page", "page.txt")), info.Text);
        // The first node is the heading "Heading one" (expected.json), whose text is the page's first line.
        Assert.IsType<NodeKind.Heading>(info.Content[0].Nodes[0].Kind);
        Assert.StartsWith("Heading one", info.Text);
    }

    [Fact]
    public void ReadsACanvas()
    {
        var info = NvCore.ReadPage(Page("canvas-boxes"));
        Assert.Equal(PageKind.Canvas, info.Kind);
        Assert.Equal(new[] { "top", "a", "b", "c", "empty", "blank" }, info.Boxes.Select(b => b.Id).ToArray());
        Assert.Equal("Top box", info.Headings.First().Text);
    }

    [Fact]
    public void BoxContent()
    {
        var content = NvCore.PageContent(Page("lists"));
        Assert.Null(content.First().BoxId);
        Assert.Equal("b1", content.Last().BoxId);
        Assert.IsType<NodeKind.BulletList>(content.Last().Nodes.First().Kind);
        var ordered = content.Last().Nodes.First(n => n.Kind is NodeKind.OrderedList);
        Assert.Equal(new[] { "1.", "2.", "3." }, ordered.Markers);
        var info = NvCore.ReadPage(Page("document-page"));
        var runs = info.Content[0].Nodes.SelectMany(n => n.Children).SelectMany(c => c.Runs);
        Assert.Contains(runs, r => r.Text == "bold" && r.Marks.SequenceEqual(new Mark[] { new Mark.Bold() }));
    }

    [Fact]
    public void ErrorsAndMarkers()
    {
        Assert.ThrowsAny<System.Exception>(() => NvCore.ReadPage(new byte[] { 1, 2, 3 }));
        Assert.Equal("MCMXCIV", NvCore.ListMarker("I", 1994));
    }

    [Fact]
    public void CoreNeedsASignIn()
    {
        using var core = new Core("http://127.0.0.1:9");
        Assert.Null(core.User());
        Assert.Throws<CoreException.SignedOut>(() => core.Workspaces());
    }

    [Fact]
    public void CoreWithAStore()
    {
        var dir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "nv-store-" + System.Guid.NewGuid());
        try
        {
            using var core = Core.WithStore("http://127.0.0.1:9", System.IO.Path.Combine(dir, "store.db"));
            Assert.True(core.HasStore());
            Assert.Null(core.CachedWorkspaces());
            core.SignOut();
            Assert.True(System.IO.File.Exists(System.IO.Path.Combine(dir, "store.db")));
        }
        finally
        {
            try { System.IO.Directory.Delete(dir, true); } catch { }
        }
    }

    // A foreign trait implemented in C# is called from a core thread (the page's own thread).
    private sealed class Heard : LivePageListener
    {
        public readonly System.Collections.Concurrent.ConcurrentQueue<LiveStatus> Statuses = new();
        public readonly System.Threading.ManualResetEventSlim Ended = new(false);
        public void OnStatus(LiveStatus status)
        {
            Statuses.Enqueue(status);
            if (status is LiveStatus.Ended) Ended.Set();
        }
        public void OnChange(PageInfo page) { }
    }

    [Fact]
    public void ALivePageWithoutASessionEnds()
    {
        using var core = new Core("http://127.0.0.1:9");
        var heard = new Heard();
        using var page = core.OpenLivePage("p1", heard);
        Assert.True(heard.Ended.Wait(System.TimeSpan.FromSeconds(10)));
        Assert.IsType<LiveStatus.Connecting>(heard.Statuses.First());
        Assert.IsType<LiveStatus.Ended>(heard.Statuses.Last());
        Assert.Equal(0u, page.UnsentUpdates());
        page.Close();
        Assert.Empty(core.UnsentPages());
    }
}
