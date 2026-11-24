using Notivelo.Windows.Text;
using Xunit;

namespace Notivelo.Windows.Tests;

/// <summary>Images and attachments: which upload is a picture, size words, aspect ratio and resize, the file card's icon, upload errors.</summary>
public class MediaRulesTests
{
    [Theory]
    [InlineData("image/png", true)]
    [InlineData("image/jpeg", true)]
    [InlineData("image/webp", true)]
    [InlineData("IMAGE/GIF", true)]
    [InlineData("image/heic", false)]      // browsers can't draw it: a file card, as on the web
    [InlineData("image/heif", false)]
    [InlineData("image/svg+xml", false)]   // stored as a download
    [InlineData("application/pdf", false)]
    [InlineData("application/octet-stream", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Only_drawable_images_become_image_blocks(string? mime, bool image) => Assert.Equal(image, MediaRules.IsImage(mime));

    [Theory]
    [InlineData(0, "")]
    [InlineData(1, "1 B")]
    [InlineData(1023, "1023 B")]
    [InlineData(1024, "1 KB")]
    [InlineData(1536, "2 KB")]
    [InlineData(1048576, "1.0 MB")]
    [InlineData(25 * 1048576, "25.0 MB")]
    public void Sizes_read_like_the_web(double bytes, string text) => Assert.Equal(text, MediaRules.SizeText(bytes));

    [Fact]
    public void Resize_keeps_the_pictures_proportions_and_the_minimum_width()
    {
        Assert.Equal(150, MediaRules.HeightFor(300, 2000, 1000));
        Assert.Equal(40, MediaRules.HeightFor(20, 2000, 1000));   // 20 is clamped to 80 first
        Assert.Equal(80, MediaRules.ClampWidth(12));
        Assert.Equal(241, MediaRules.ClampWidth(240.6));
        Assert.Null(MediaRules.HeightFor(300, 0, 0));
    }

    [Fact]
    public void Display_size_uses_what_is_stored_then_the_picture_then_a_placeholder()
    {
        Assert.Equal((300, 200), MediaRules.DisplaySize(300, 200, 3000, 1000, 800));   // both stored: as they are
        Assert.Equal((300, 100), MediaRules.DisplaySize(300, 0, 3000, 1000, 800));     // width only: the picture's aspect
        Assert.Equal((800, 267), MediaRules.DisplaySize(0, 0, 3000, 1000, 800));       // nothing stored: its own size, shrunk to the box
        Assert.Equal((600, 400), MediaRules.DisplaySize(1200, 800, 0, 0, 600));        // wider than the box: shrunk with its proportions
        Assert.Equal((320, 120), MediaRules.DisplaySize(0, 0, 0, 0, 800));             // not loaded yet: the placeholder
    }

    [Theory]
    [InlineData("image/png", "a.png", "file-image")]
    [InlineData("video/mp4", "a.mp4", "file-play")]
    [InlineData("audio/mpeg", "a.mp3", "file-headphone")]
    [InlineData("application/zip", "a.zip", "file-archive")]
    [InlineData("application/octet-stream", "backup.7z", "file-archive")]
    [InlineData("text/csv", "a.csv", "file-spreadsheet")]
    [InlineData("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "a.xlsx", "file-spreadsheet")]
    [InlineData("application/pdf", "a.pdf", "file-text")]
    [InlineData("text/plain", "a.txt", "file-text")]
    [InlineData("application/octet-stream", "a.bin", "file")]
    public void File_cards_pick_an_icon_like_the_web(string mime, string name, string icon) => Assert.Equal(icon, MediaRules.IconOf(mime, name));

    [Theory]
    [InlineData("Photo.PNG", "image/png")]
    [InlineData("scan.heic", "image/heic")]
    [InlineData("notes.pdf", "application/pdf")]
    [InlineData("logo.svg", "application/octet-stream")]
    [InlineData("noext", "application/octet-stream")]
    [InlineData(".gitignore", "application/octet-stream")]
    public void The_sample_types_files_like_the_server(string name, string mime) => Assert.Equal(mime, MediaRules.MimeOf(name));

    [Fact]
    public void Upload_errors_are_one_sentence_each()
    {
        Assert.Equal("“big.zip” is larger than 25 MB.", MediaRules.UploadError(413, "file_too_large", "x", "big.zip", false));
        Assert.Equal("“a.txt” is empty.", MediaRules.UploadError(400, "file_empty", null, "a.txt", false));
        Assert.Equal("You have view-only access to this page.", MediaRules.UploadError(403, null, "You have view-only access", "a.txt", false));
        Assert.Contains("offline", MediaRules.UploadError(null, null, null, "a.txt", true));
        Assert.Equal("The server is busy.", MediaRules.UploadError(503, null, "The server is busy.", "a.txt", false));
        Assert.Equal("Couldn't add “file”.", MediaRules.UploadError(500, null, "", "  ", false));
        Assert.True(MediaRules.MaxBytes < 26L * 1024 * 1024 && MediaRules.MaxBytes > 24L * 1024 * 1024);
    }

    [Fact]
    public void Temp_file_names_cannot_escape_the_folder()
    {
        Assert.Equal("a_b_c.txt", MediaRules.SafeFileName("a/b" + (char)92 + "c.txt"));
        Assert.Equal("file", MediaRules.SafeFileName("..."));
        Assert.Equal("file", MediaRules.SafeFileName(null));
        Assert.Equal(120, MediaRules.SafeFileName(new string('x', 300)).Length);
    }
}
