using Notivelo.Windows.Data;
using Notivelo.Windows.Text;
using Xunit;

namespace Notivelo.Windows.Tests;

/// <summary>The left2 batch's pure rules: a section's default template, the blank-page test of the template strip, where a template is offered, presence and the table menu.</summary>
public class Left2RulesTests
{
    [Fact]
    public void The_nearest_section_with_a_choice_decides_the_default()
    {
        var chain = new[] { "child", "parent", "root" };
        Assert.Null(TemplateRules.EffectiveDefault(chain, new Dictionary<string, string?>()));
        Assert.Equal("t1", TemplateRules.EffectiveDefault(chain, new Dictionary<string, string?> { ["root"] = "t1" }));
        Assert.Equal("t2", TemplateRules.EffectiveDefault(chain, new Dictionary<string, string?> { ["root"] = "t1", ["parent"] = "t2" }));
        // "None" on a section stops the search: blank pages there
        Assert.Null(TemplateRules.EffectiveDefault(chain, new Dictionary<string, string?> { ["root"] = "t1", ["child"] = null }));
        Assert.Equal("t1", TemplateRules.EffectiveDefault(new[] { "root" }, new Dictionary<string, string?> { ["root"] = "t1", ["child"] = null }));
    }

    private static CanvasBox Box(params BoxBlock[] b) => new(0, 0, 100, false, b);

    [Fact]
    public void A_page_with_no_text_task_or_ink_is_blank()
    {
        Assert.True(TemplateRules.PageIsBlank(Array.Empty<CanvasBox>(), 0));
        Assert.True(TemplateRules.PageIsBlank(new[] { Box(new BoxBlock(BlockKind.Paragraph, "")), Box(new BoxBlock(BlockKind.Paragraph, "  ")) }, 0));
        Assert.False(TemplateRules.PageIsBlank(new[] { Box(new BoxBlock(BlockKind.Paragraph, "Hi")) }, 0));
        Assert.False(TemplateRules.PageIsBlank(new[] { Box(new BoxBlock(BlockKind.Rule, "")) }, 0));
        Assert.False(TemplateRules.PageIsBlank(Array.Empty<CanvasBox>(), 2));
        var task = new TaskItem("t", "", false, 0, null, DueTone.None, false, null, null, null, Array.Empty<string>(), 0, 0);
        Assert.False(TemplateRules.PageIsBlank(new[] { Box(new BoxBlock(BlockKind.Task, "", task)) }, 0));
    }

    [Fact]
    public void Scopes_are_added_and_taken_off_one_section_at_a_time()
    {
        var one = TemplateRules.WithScope(null, "a", true);
        Assert.Equal(new[] { ("a", true) }, one);
        var two = TemplateRules.WithScope(one, "b", true, false);
        Assert.Equal(new[] { ("a", true), ("b", false) }, two);
        Assert.Equal(new[] { ("b", false) }, TemplateRules.WithScope(two, "a", false));
        Assert.Empty(TemplateRules.WithScope(one, "a", false));            // none left: offered everywhere again
        Assert.Equal(new[] { ("a", false) }, TemplateRules.WithScope(one, "a", true, false));   // adding twice keeps one entry
    }

    [Fact]
    public void The_manager_says_where_a_template_is_offered()
    {
        string? Name(string id) => id switch { "a" => "Corpus", "b" => "Inbox", _ => null };
        Assert.Equal("Offered in every section", TemplateRules.ScopeText(false, null, Name));
        Assert.Equal("Offered in Corpus, Inbox", TemplateRules.ScopeText(true, new[] { ("a", true), ("b", false) }, Name));
        Assert.Equal("Offered in some sections", TemplateRules.ScopeText(true, new[] { ("gone", true) }, Name));
    }

    private static string State(string id, string name, bool? canEdit = true, string color = "#0ea5e9") =>
        "{\"user\":{\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"color\":\"" + color + "\"" + (canEdit is null ? "" : ",\"canEdit\":" + (canEdit.Value ? "true" : "false")) + "}}";

    [Fact]
    public void Presence_lists_the_others_once_each_sorted_by_name()
    {
        var people = PresenceRules.From(new[] { State("me", "Me"), State("z", "Zed"), State("a", "Amy", false), State("z", "Zed", false), "{}", "not json", "{\"user\":{\"name\":\"x\"}}" }, "me");
        Assert.Equal(new[] { "Amy", "Zed" }, people.Select(p => p.Name));
        Assert.False(people[0].CanEdit);
        Assert.Equal(2, people[1].Sessions);
        Assert.True(people[1].CanEdit);          // editing if either device edits
        Assert.Equal("Zed · 2 devices".Replace("Zed", "editing"), PresenceRules.Role(people[1]));
        Assert.Equal("viewing", PresenceRules.Role(people[0]));
    }

    [Fact]
    public void Presence_fills_in_a_missing_name_colour_and_edit_flag()
    {
        var p = Assert.Single(PresenceRules.From(new[] { "{\"user\":{\"id\":\"u\",\"color\":\"red\"}}" }, null));
        Assert.Equal("Someone", p.Name);
        Assert.Equal("#888888", p.Color);
        Assert.True(p.CanEdit);
    }

    [Fact]
    public void The_avatar_stack_says_who_is_here_and_keeps_one_circle_for_the_rest()
    {
        var one = PresenceRules.From(new[] { State("a", "Amy") }, null);
        Assert.Equal("Amy is here", PresenceRules.Label(one));
        var many = PresenceRules.From(new[] { State("a", "Amy"), State("b", "Bo") }, null);
        Assert.Equal("2 people are here", PresenceRules.Label(many));
        Assert.Equal(3, PresenceRules.Shown(3, 4));
        Assert.Equal(3, PresenceRules.Shown(6, 4));       // the fourth circle is "+3"
        Assert.True(PresenceRules.Same(many, PresenceRules.From(new[] { State("b", "Bo"), State("a", "Amy") }, null)));
        Assert.False(PresenceRules.Same(many, one));
    }

    [Fact]
    public void The_table_menu_runs_engine_commands_and_a_table_has_a_shape()
    {
        var cmds = TableTools.Menu.Select(m => m.Command).Where(c => c.Length > 0).ToList();
        foreach (var c in new[] { "addRowBefore", "addRowAfter", "addColumnBefore", "addColumnAfter", "toggleHeaderRow", "deleteRow", "deleteColumn", "deleteTable" }) Assert.Contains(c, cmds);
        Assert.Equal("", TableTools.Shapes(new List<List<List<int>>>()));
        var t = new List<List<int>> { new() { 1, 1, 1 }, new() { 1, 1, 1 } };
        Assert.Equal("2x3,2x3", TableTools.Shapes(new List<List<List<int>>> { t, t }));
    }
}
