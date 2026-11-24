using System.Drawing;
using System.IO.Compression;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Input;
using Xunit;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

/// <summary>Files for the picture and attachment tests. The system file dialog can't be driven, so the app (offline test mode only) takes the paths in
/// <c>NOTIVELO_TEST_PICK</c> (separated by <c>|</c>) as what the dialog returns.</summary>
internal static class TestMedia
{
    private static readonly uint[] CrcTable = Enumerable.Range(0, 256).Select(n =>
    {
        var c = (uint)n;
        for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
        return c;
    }).ToArray();

    private static uint Crc(byte[] b) { var c = 0xFFFFFFFFu; foreach (var x in b) c = CrcTable[(c ^ x) & 0xFF] ^ (c >> 8); return c ^ 0xFFFFFFFFu; }

    private static void Be(Stream o, uint v) { o.WriteByte((byte)(v >> 24)); o.WriteByte((byte)(v >> 16)); o.WriteByte((byte)(v >> 8)); o.WriteByte((byte)v); }

    private static void Chunk(Stream o, string type, byte[] data)
    {
        Be(o, (uint)data.Length);
        var td = System.Text.Encoding.ASCII.GetBytes(type).Concat(data).ToArray();
        o.Write(td);
        Be(o, Crc(td));
    }

    /// <summary>A w x h PNG, a blue-to-green gradient (no imaging library needed).</summary>
    public static byte[] Png(int w, int h)
    {
        var raw = new MemoryStream();
        for (var y = 0; y < h; y++)
        {
            raw.WriteByte(0);
            for (var x = 0; x < w; x++) { raw.WriteByte(40); raw.WriteByte((byte)(90 + 120 * x / w)); raw.WriteByte((byte)(220 - 120 * y / h)); }
        }
        var z = new MemoryStream();
        using (var zs = new ZLibStream(z, CompressionLevel.Fastest, true)) zs.Write(raw.ToArray());
        var o = new MemoryStream();
        o.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });
        var ihdr = new MemoryStream();
        Be(ihdr, (uint)w); Be(ihdr, (uint)h);
        ihdr.Write(new byte[] { 8, 2, 0, 0, 0 });
        Chunk(o, "IHDR", ihdr.ToArray());
        Chunk(o, "IDAT", z.ToArray());
        Chunk(o, "IEND", Array.Empty<byte>());
        return o.ToArray();
    }

    private static string Dir
    {
        get { var d = Path.Combine(Path.GetTempPath(), "notivelo-uitest-media"); Directory.CreateDirectory(d); return d; }
    }

    public static string WritePng(string name, int w, int h) { var p = Path.Combine(Dir, name); File.WriteAllBytes(p, Png(w, h)); return p; }

    /// <summary>A file of <paramref name="bytes"/> bytes (zeros after a short header).</summary>
    public static string WriteFile(string name, int bytes)
    {
        var p = Path.Combine(Dir, name);
        var b = new byte[bytes];
        System.Text.Encoding.ASCII.GetBytes("%PDF-1.4 sample").CopyTo(b, 0);
        File.WriteAllBytes(p, b);
        return p;
    }

    public static IReadOnlyDictionary<string, string> Pick(params string[] paths) => new Dictionary<string, string>
    {
        ["NOTIVELO_TEST_PICK"] = string.Join("|", paths), ["NOTIVELO_TEST_NOLAUNCH"] = "1",
    };
}

/// <summary>Pictures and file cards in a box (offline sample: uploads stay in memory): insert from the ribbon and the slash menu, draw, select, resize, open.</summary>
public class MediaTests
{
    private static void Click(AppHost h, string id)
    {
        var e = AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)), id);
        if (e.Patterns.Invoke.IsSupported) e.Patterns.Invoke.Pattern.Invoke(); else e.Click();
    }

    [Fact]
    public void Ribbon_picture_uploads_and_draws_the_image()
    {
        var png = TestMedia.WritePng("ui-picture.png", 200, 100);
        using var h = AppHost.Launch(TestMedia.Pick(png));
        try
        {
            h.A.Focus();
            Click(h, "ribbon-picture");
            h.A.WaitMedia("images", v => v == "loaded", "the picture drawn");
            Assert.Equal("200x100", h.A.Media("sizes"));
            Assert.Equal("", h.A.Media("files"));
            Assert.Equal("0", h.A.Media("upload"));
        }
        catch { h.Shot(nameof(Ribbon_picture_uploads_and_draws_the_image)); throw; }
    }

    [Fact]
    public void Ribbon_file_adds_a_file_card()
    {
        var pdf = TestMedia.WriteFile("Quarterly report.pdf", 1_258_291);
        using var h = AppHost.Launch(TestMedia.Pick(pdf));
        try
        {
            h.A.Focus();
            Click(h, "ribbon-file");
            h.A.WaitMedia("files", v => v == "Quarterly report.pdf", "the file card");
            Assert.Equal("", h.A.Media("images"));
        }
        catch { h.Shot(nameof(Ribbon_file_adds_a_file_card)); throw; }
    }

    [Fact]
    public void A_picture_and_an_unknown_type_picked_together_become_an_image_and_a_card()
    {
        var png = TestMedia.WritePng("ui-both.png", 80, 60);
        var zip = TestMedia.WriteFile("archive.zip", 4096);
        using var h = AppHost.Launch(TestMedia.Pick(png, zip));
        try
        {
            h.A.Focus();
            Click(h, "ribbon-file");
            h.A.WaitMedia("files", v => v == "archive.zip", "the zip card");
            h.A.WaitMedia("images", v => v == "loaded", "the picture");
        }
        catch { h.Shot(nameof(A_picture_and_an_unknown_type_picked_together_become_an_image_and_a_card)); throw; }
    }

    [Fact]
    public void Slash_image_opens_the_picker_and_inserts()
    {
        var png = TestMedia.WritePng("ui-slash.png", 120, 80);
        using var h = AppHost.Launch(TestMedia.Pick(png));
        try
        {
            h.A.Focus();
            h.Type("/image");
            h.A.WaitFor(x => x.Menu.StartsWith("slash:"), "the slash menu");
            h.Press(ENTER);
            h.A.WaitMedia("images", v => v == "loaded", "the picture drawn");
            Assert.DoesNotContain("/image", h.A.State.Text);   // the typed text is gone
        }
        catch { h.Shot(nameof(Slash_image_opens_the_picker_and_inserts)); throw; }
    }

    [Fact]
    public void Click_selects_the_picture_and_a_handle_drag_resizes_it()
    {
        var png = TestMedia.WritePng("ui-resize.png", 200, 100);
        using var h = AppHost.Launch(TestMedia.Pick(png));
        try
        {
            h.A.Focus();
            Click(h, "ribbon-picture");
            h.A.WaitMedia("images", v => v == "loaded", "the picture drawn");
            var r = h.A.Bounds;
            // the picture sits at the view's top left, 200 x 100
            Mouse.Click(new Point(r.Left + 60, r.Top + 40));
            h.A.WaitMedia("node", v => v == "image", "the picture selected");
            var corner = new Point(r.Left + 200, r.Top + 100);
            Mouse.Drag(corner, new Point(corner.X - 80, corner.Y - 40));
            h.A.WaitMedia("sizes", v => v == "120x60", "the picture 120 wide");
        }
        catch { h.Shot(nameof(Click_selects_the_picture_and_a_handle_drag_resizes_it)); throw; }
    }

    [Fact]
    public void Double_click_opens_a_file_card_from_a_temp_copy()
    {
        var name = "open-" + Guid.NewGuid().ToString("N")[..8] + ".txt";
        var file = TestMedia.WriteFile(name, 2048);
        using var h = AppHost.Launch(TestMedia.Pick(file));
        try
        {
            h.A.Focus();
            Click(h, "ribbon-file");
            h.A.WaitMedia("files", v => v == name, "the file card");
            var r = h.A.Bounds;
            Mouse.DoubleClick(new Point(r.Left + 200, r.Top + 26));
            var log = Path.Combine(Path.GetTempPath(), "notivelo-text.log");
            AppHost.Wait(() => File.Exists(log) && ReadShared(log).Contains(name) ? "x" : null, "the file written to the temp folder", 15000);
        }
        catch { h.Shot(nameof(Double_click_opens_a_file_card_from_a_temp_copy)); throw; }
    }

    private static string ReadShared(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var sr = new StreamReader(fs);
        return sr.ReadToEnd();
    }
}
