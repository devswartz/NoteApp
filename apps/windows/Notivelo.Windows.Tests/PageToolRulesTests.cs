using Notivelo.Windows.Data;
using Xunit;

namespace Notivelo.Windows.Tests;

/// <summary>Page tools: export file names, the locked-pages password rule, comment text with @mentions, version words, page icons, the sample's Markdown.</summary>
public class PageToolRulesTests
{
    [Theory]
    [InlineData("Weekly sync", "Weekly sync.md")]
    [InlineData("", "Untitled.md")]
    [InlineData("   ", "Untitled.md")]
    [InlineData("a/b\\c:d*e?f\"g<h>i|j", "a b c d e f g h i j.md")]
    [InlineData("Line\nbreak", "Line break.md")]
    public void Export_file_names_have_no_path_characters(string title, string name) => Assert.Equal(name, PageToolRules.ExportFileName(title));

    [Fact]
    public void Export_file_names_stop_at_80_characters() => Assert.Equal(80 + 3, PageToolRules.ExportFileName(new string('x', 200)).Length);

    [Theory]
    [InlineData("sam@example.com", true)]
    [InlineData(" sam@example.com ", true)]
    [InlineData("sam@example", false)]
    [InlineData("sam@.com", false)]
    [InlineData("sam@example.", false)]
    [InlineData("@example.com", false)]
    [InlineData("two words@example.com", false)]
    [InlineData("a@b@c.com", false)]
    [InlineData("Sam", false)]
    public void Email_shapes(string text, bool email) => Assert.Equal(email, PageToolRules.LooksLikeEmail(text));

    [Theory]
    [InlineData("secret", "secret", null)]
    [InlineData("short", "short", "Use at least 6 characters.")]
    [InlineData("secret1", "secret2", "The two passwords differ.")]
    public void The_lock_password_needs_six_characters_and_a_matching_repeat(string a, string b, string? problem) => Assert.Equal(problem, PageToolRules.PasswordProblem(a, b));

    [Fact]
    public void The_lock_password_counts_bytes_up_to_72()
    {
        Assert.Null(PageToolRules.PasswordProblem(new string('a', 72), new string('a', 72)));
        Assert.Equal("Use at most 72 characters.", PageToolRules.PasswordProblem(new string('a', 73), new string('a', 73)));
        Assert.Equal("Use at most 72 characters.", PageToolRules.PasswordProblem(new string('é', 37), new string('é', 37)));   // 74 bytes
        Assert.Null(PageToolRules.PasswordProblem("ééé", "ééé"));   // 6 bytes
    }

    [Fact]
    public void Comment_text_splits_into_runs_and_mentions()
    {
        const string id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        var pieces = PageToolRules.Pieces($"Hi @[Sam Rivera]({id}), see this @[Priya]({id})!");
        Assert.Equal(new[] { "Hi ", "@Sam Rivera", ", see this ", "@Priya", "!" }, pieces.Select(p => p.Text));
        Assert.Equal(new string?[] { null, id, null, id, null }, pieces.Select(p => p.MentionId));
        Assert.Equal("plain", Assert.Single(PageToolRules.Pieces("plain")).Text);
        Assert.Empty(PageToolRules.Pieces(""));
        Assert.Equal("@[bad](not-an-id)", Assert.Single(PageToolRules.Pieces("@[bad](not-an-id)")).Text);
    }

    [Theory]
    [InlineData("hello @sa", "sa")]
    [InlineData("@", "")]
    [InlineData("a @b.c-d", "b.c-d")]
    [InlineData("mail me@example.com", null)]   // an @ inside a word is not a mention
    [InlineData("hello", null)]
    [InlineData("hello @sam there", null)]
    public void The_mention_query_is_the_trailing_at_word(string text, string? query) => Assert.Equal(query, PageToolRules.MentionQuery(text));

    [Fact]
    public void Picking_a_mention_replaces_the_typed_word()
    {
        const string id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        Assert.Equal($"Hi @[Sam Rivera]({id}) ", PageToolRules.InsertMention("Hi @sa", "Sam Rivera", id));
        Assert.Equal($"@[Sam]({id}) ", PageToolRules.InsertMention("@", "Sam", id));
    }

    [Fact]
    public void Ago_words()
    {
        var now = new DateTimeOffset(2026, 11, 23, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal("just now", PageToolRules.Ago(now.AddSeconds(-10).ToString("o"), now));
        Assert.Equal("1 minute ago", PageToolRules.Ago(now.AddMinutes(-1).ToString("o"), now));
        Assert.Equal("12 minutes ago", PageToolRules.Ago(now.AddMinutes(-12).ToString("o"), now));
        Assert.Equal("1 hour ago", PageToolRules.Ago(now.AddHours(-1).ToString("o"), now));
        Assert.Equal("5 hours ago", PageToolRules.Ago(now.AddHours(-5).ToString("o"), now));
        Assert.Equal("2 days ago", PageToolRules.Ago(now.AddDays(-2).ToString("o"), now));
        Assert.Equal("", PageToolRules.Ago("nonsense", now));
    }

    [Theory]
    [InlineData("auto", "")]
    [InlineData("manual", " · saved")]
    [InlineData("restore", " · before restore")]
    public void Version_tags(string reason, string tag) => Assert.Equal(tag, PageToolRules.VersionTag(reason));

    [Fact]
    public void Icon_search_matches_the_words_and_an_empty_query_lists_all()
    {
        Assert.Equal(PageToolRules.Icons.Count, PageToolRules.FilterIcons("").Count);
        Assert.Equal(PageToolRules.Icons.Count, PageToolRules.FilterIcons("  ").Count);
        var rocket = PageToolRules.FilterIcons("ROCKET");
        Assert.Equal("\U0001F680", Assert.Single(rocket).Emoji);
        Assert.Empty(PageToolRules.FilterIcons("zzzz"));
        Assert.True(PageToolRules.Icons.Select(i => i.Emoji).Distinct().Count() == PageToolRules.Icons.Count);
    }

    [Theory]
    [InlineData("\U0001F600", true)]
    [InlineData(" \U0001F680 ", true)]
    [InlineData("❤️", true)]
    [InlineData("\U0001F468‍\U0001F4BB", true)]
    [InlineData("a", false)]
    [InlineData("rocket", false)]
    [InlineData("", false)]
    public void Typed_emoji(string text, bool emoji) => Assert.Equal(emoji, PageToolRules.AsEmoji(text) is not null);

    [Fact]
    public void The_sample_page_writes_as_markdown()
    {
        var page = new NotePage("p", "Plan", "Edited", "NB", "#fff", Array.Empty<string>(), PageColour.None, RuleLines.None, new CanvasBox[]
        {
            new(0, 100, 300, false, new BoxBlock[] { new(BlockKind.Paragraph, "Later") }),
            new(0, 0, 300, false, new BoxBlock[]
            {
                new(BlockKind.Heading2, "Goals"),
                new(BlockKind.ListItem, "one", Indent: 0),
                new(BlockKind.ListItem, "two", Indent: 1),
                new(BlockKind.CheckItem, "done thing", Checked: true),
                new(BlockKind.Quote, "wise words"),
            }),
        }, 0, 0);
        Assert.Equal("# Plan\n\n## Goals\n\n- one\n  - two\n- [x] done thing\n> wise words\n\nLater\n", PageToolRules.Markdown(page));
    }
}
