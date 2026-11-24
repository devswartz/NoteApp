using System.Text.Json;
using Notivelo.Windows.Text;
using Xunit;

namespace Notivelo.Windows.Tests;

/// <summary>The left batch's pure rules: the box clipboard, the built-in templates, the reminder toasts and the print layout.</summary>
public class LeftBatchRulesTests
{
    private const string Clip = "{\"boxes\":[{\"x\":10,\"y\":20,\"w\":300,\"content\":[]}],\"text\":\"hello\",\"cut\":false}";

    [Fact]
    public void A_clip_has_boxes_and_plain_text()
    {
        Assert.True(BoxClipboardRules.IsClip(Clip));
        Assert.True(BoxClipboardRules.IsClip("[{\"x\":1}]"));
        Assert.False(BoxClipboardRules.IsClip("{\"boxes\":[]}"));
        Assert.False(BoxClipboardRules.IsClip("not json"));
        Assert.False(BoxClipboardRules.IsClip(null));
        Assert.Equal("hello", BoxClipboardRules.PlainText(Clip));
        Assert.Equal("", BoxClipboardRules.PlainText("[1]"));
        Assert.Equal("", BoxClipboardRules.PlainText("nope"));
    }

    [Fact]
    public void Paste_takes_the_clipboards_own_clip_else_the_apps_while_the_text_is_unchanged()
    {
        Assert.Equal(Clip, BoxClipboardRules.Choose(Clip, "x", null));
        Assert.Equal(Clip, BoxClipboardRules.Choose(null, "hello", Clip));        // the system format was dropped but nothing else was copied
        Assert.Null(BoxClipboardRules.Choose(null, "something copied elsewhere", Clip));
        Assert.Null(BoxClipboardRules.Choose("junk", "hello", null));
        Assert.Null(BoxClipboardRules.Choose(null, null, null));
    }

    [Fact]
    public void A_pasted_group_without_a_pointer_steps_down_and_right_off_existing_boxes()
    {
        Assert.Equal((40.0, 40.0), BoxClipboardRules.Nudge(40, 40, new[] { (500.0, 500.0) }));
        Assert.Equal((64.0, 64.0), BoxClipboardRules.Nudge(40, 40, new[] { (40.0, 40.0) }));
        Assert.Equal((88.0, 88.0), BoxClipboardRules.Nudge(40, 40, new[] { (40.0, 40.0), (64.0, 64.0) }));
        Assert.Equal((64.0, 64.0), BoxClipboardRules.Nudge(40.4, 40.2, new[] { (40.0, 40.0) }));   // positions are whole points
    }

    [Theory]
    [InlineData("C", true, false, "copy")]
    [InlineData("x", true, false, "cut")]
    [InlineData("D", true, false, "duplicate")]
    [InlineData("V", true, false, "paste")]
    [InlineData("Delete", false, false, "delete")]
    [InlineData("Back", false, false, "delete")]
    [InlineData("Escape", false, false, "deselect")]
    [InlineData("C", false, false, null)]
    [InlineData("C", true, true, null)]
    [InlineData("Delete", true, false, null)]
    [InlineData("A", true, false, null)]
    public void Keys_on_a_selected_box(string key, bool ctrl, bool shift, string? expected) => Assert.Equal(expected, BoxClipboardRules.KeyAction(key, ctrl, shift));

    [Fact]
    public void Selected_boxes_come_in_page_order() =>
        Assert.Equal(new[] { "a", "c" }, BoxClipboardRules.InOrder(new[] { "c", "a", "zz" }, new[] { "a", "b", "c" }));

    [Theory]
    [InlineData("builtin:meeting", 3)]
    [InlineData("builtin:project", 5)]
    [InlineData("builtin:journal", 4)]
    public void Built_in_templates_are_a_doc_of_canvas_boxes(string id, int boxes)
    {
        using var doc = JsonDocument.Parse(TemplateRules.ContentJson(id, new DateTime(2026, 11, 24)));
        var root = doc.RootElement;
        Assert.Equal("doc", root.GetProperty("type").GetString());
        var content = root.GetProperty("content");
        Assert.Equal(boxes, content.GetArrayLength());
        var z = 0;
        foreach (var b in content.EnumerateArray())
        {
            Assert.Equal("canvasBox", b.GetProperty("type").GetString());
            Assert.Equal(++z, b.GetProperty("attrs").GetProperty("z").GetInt32());
            Assert.True(b.GetProperty("attrs").GetProperty("w").GetDouble() >= 300);
            Assert.True(b.GetProperty("content").GetArrayLength() > 0);
        }
    }

    [Fact]
    public void The_meeting_template_starts_with_todays_date_and_the_page_is_titled_from_it()
    {
        var day = new DateTime(2026, 11, 24);
        Assert.Contains(TemplateRules.LongDate(day), TemplateRules.ContentJson("builtin:meeting", day));
        Assert.StartsWith("Meeting · ", TemplateRules.TitleOf("builtin:meeting", day));
        Assert.Equal("New project", TemplateRules.TitleOf("builtin:project", day));
        Assert.Equal(TemplateRules.LongDate(day), TemplateRules.TitleOf("builtin:journal", day));
        Assert.Equal("", TemplateRules.TitleOf("other", day));
        Assert.All(TemplateRules.Builtins, t => Assert.True(TemplateRules.IsBuiltin(t.Id)));
        Assert.Equal(3, TemplateRules.Builtins.Count);
    }

    [Fact]
    public void A_scoped_template_is_offered_in_its_section_and_in_subsections_only_when_asked()
    {
        var chain = new[] { "child", "parent", "top" };      // the section, then its parents
        Assert.True(TemplateRules.Offered(false, Array.Empty<(string, bool)>(), chain));
        Assert.True(TemplateRules.Offered(true, new[] { ("child", false) }, chain));
        Assert.False(TemplateRules.Offered(true, new[] { ("parent", false) }, chain));
        Assert.True(TemplateRules.Offered(true, new[] { ("parent", true) }, chain));
        Assert.False(TemplateRules.Offered(true, new[] { ("elsewhere", true) }, chain));
        Assert.False(TemplateRules.Offered(true, Array.Empty<(string, bool)>(), chain));
    }

    private static ReminderEntry Entry(string id, DateTime at, string title = "Pay rent", string? due = "2026-11-25", string? time = "09:00", bool locked = false) =>
        new(id, "t1", title, at, due, time, "p1", "w1", locked);

    [Fact]
    public void Toast_words_follow_the_push_payload()
    {
        var now = DateTime.UtcNow;
        Assert.Equal("Pay rent", ReminderRules.TitleOf(Entry("r", now)));
        Assert.Equal("Task reminder", ReminderRules.TitleOf(Entry("r", now, title: "  ")));
        Assert.Equal("Task reminder", ReminderRules.TitleOf(Entry("r", now, locked: true)));     // a locked page shows no task text
        Assert.Equal("Due 2026-11-25 at 09:00", ReminderRules.BodyOf(Entry("r", now)));
        Assert.Equal("Due 2026-11-25", ReminderRules.BodyOf(Entry("r", now, time: null)));
        Assert.Equal("Reminder", ReminderRules.BodyOf(Entry("r", now, due: null, time: null)));
    }

    [Fact]
    public void Only_reminders_ahead_are_planned_soonest_first_one_per_id_and_capped()
    {
        var now = new DateTime(2026, 11, 24, 12, 0, 0, DateTimeKind.Utc);
        var plan = ReminderRules.Plan(new[]
        {
            Entry("late", now.AddHours(5)), Entry("past", now.AddMinutes(-1)), Entry("soon", now.AddMinutes(10)), Entry("soon", now.AddMinutes(11)), Entry("now", now.AddSeconds(2)),
        }, now);
        Assert.Equal(new[] { "soon", "late" }, plan.Select(p => p.ReminderId));
        var many = Enumerable.Range(1, 80).Select(i => Entry("r" + i, now.AddMinutes(i)));
        Assert.Equal(ReminderRules.MaxScheduled, ReminderRules.Plan(many, now).Count);
    }

    [Fact]
    public void Snooze_options_end_in_ten_minutes_an_hour_or_tomorrow_morning()
    {
        var now = new DateTime(2026, 11, 24, 15, 30, 0);
        Assert.Equal(now.AddMinutes(10), ReminderRules.SnoozeUntil("10m", now));
        Assert.Equal(now.AddHours(1), ReminderRules.SnoozeUntil("1h", now));
        Assert.Equal(new DateTime(2026, 11, 25, 9, 0, 0), ReminderRules.SnoozeUntil("tomorrow", now));
        Assert.Equal(new DateTime(2026, 11, 25, 8, 15, 0), ReminderRules.SnoozeUntil("tomorrow", now, new TimeSpan(8, 15, 0)));
        Assert.Null(ReminderRules.SnoozeUntil("2d", now));
        Assert.Equal(new[] { "10m", "1h", "tomorrow" }, ReminderRules.SnoozeOptions.Select(o => o.Id));
    }

    [Fact]
    public void The_toast_xml_carries_the_task_and_survives_odd_text()
    {
        var e = Entry("r1", DateTime.UtcNow.AddHours(1), title: "Fish & chips <now> \"quoted\"");
        var xml = ReminderRules.ToastXml(e, "tok_1");
        var doc = System.Xml.Linq.XDocument.Parse(xml);                        // well-formed
        Assert.Equal("Fish & chips <now> \"quoted\"", doc.Descendants("text").First().Value);
        Assert.Equal(3, doc.Descendants("selection").Count());
        var launch = ReminderRules.ParseArguments(doc.Root!.Attribute("launch")!.Value);
        Assert.Equal("open", launch["action"]); Assert.Equal("t1", launch["task"]); Assert.Equal("w1", launch["ws"]); Assert.Equal("p1", launch["page"]); Assert.Equal("tok_1", launch["token"]);
        var snooze = doc.Descendants("action").First(a => a.Attribute("content")!.Value == "Snooze").Attribute("arguments")!.Value;
        Assert.Equal("snooze", ReminderRules.ParseArguments(snooze)["action"]);
        Assert.False(ReminderRules.ParseArguments(ReminderRules.Arguments("open", e)).ContainsKey("token"));
    }

    [Fact]
    public void Instants_read_as_utc()
    {
        Assert.Equal(new DateTime(2026, 11, 25, 9, 0, 0, DateTimeKind.Utc), ReminderRules.ParseInstant("2026-11-25T09:00:00Z"));
        Assert.Equal(new DateTime(2026, 11, 25, 7, 0, 0, DateTimeKind.Utc), ReminderRules.ParseInstant("2026-11-25T09:00:00+02:00"));
        Assert.Null(ReminderRules.ParseInstant("soon"));
        Assert.Null(ReminderRules.ParseInstant(null));
    }

    [Theory]
    [InlineData(1000, 3000, 500, 800, 0.5, 2)]     // scaled to the paper's width (1500 high), then cut into sheets of 800
    [InlineData(400, 300, 500, 800, 1.0, 1)]       // small pages are not enlarged
    [InlineData(1000, 1600, 500, 800, 0.5, 1)]
    [InlineData(1000, 1602, 500, 800, 0.5, 2)]
    [InlineData(0, 0, 500, 800, 1.0, 1)]
    public void A_page_is_scaled_to_the_paper_width_and_cut_into_sheets(double cw, double ch, double pw, double ph, double scale, int sheets)
    {
        var l = PrintRules.Layout(cw, ch, pw, ph);
        Assert.Equal(scale, l.Scale, 3);
        Assert.Equal(sheets, l.Sheets);
    }

    [Fact]
    public void The_print_job_is_named_after_the_page()
    {
        Assert.Equal("Meeting notes", PrintRules.JobName("Meeting notes"));
        Assert.Equal("Notivelo page", PrintRules.JobName("  "));
        Assert.Equal("a b", PrintRules.JobName("a/b"));
        Assert.True(PrintRules.JobName(new string('x', 200)).Length <= 80);
    }
}
