using Notivelo.Windows.Data;
using Xunit;

namespace Notivelo.Windows.Tests;

public class PeopleRulesTests
{
    [Theory]
    [InlineData("", "a@b.co", "longenough", "Enter your name, email and a password.")]
    [InlineData("Demo User", "  ", "longenough", "Enter your name, email and a password.")]
    [InlineData("Demo User", "a@b.co", "", "Enter your name, email and a password.")]
    [InlineData("Demo User", "not-an-email", "longenough", "Enter a valid email address.")]
    [InlineData("Demo User", "a@b.co", "short", "Use a password of 8 to 72 characters.")]
    public void Sign_up_problems(string name, string email, string pw, string expected) => Assert.Equal(expected, PeopleRules.SignUpProblem(name, email, pw));

    [Fact]
    public void Sign_up_accepts_a_good_form_and_the_password_limits()
    {
        Assert.Null(PeopleRules.SignUpProblem("Demo User", "demo@example.com", "12345678"));
        Assert.Null(PeopleRules.SignUpProblem("Demo User", "demo@example.com", new string('x', 72)));
        Assert.NotNull(PeopleRules.SignUpProblem("Demo User", "demo@example.com", new string('x', 73)));
    }

    [Theory]
    [InlineData("https://app.notiveloapp.com/invite/abc123", "abc123")]
    [InlineData("  https://app.notiveloapp.com/invites/abc123?x=1#y ", "abc123")]
    [InlineData("abc123", "abc123")]
    [InlineData("app.example.com/invite/abc123/", "abc123")]
    [InlineData("", "")]
    public void Token_from_a_pasted_link(string text, string token) => Assert.Equal(token, PeopleRules.TokenFromLink(text));

    [Fact]
    public void Only_an_owner_makes_or_touches_an_owner()
    {
        Assert.Equal(new[] { "owner", "admin", "member", "viewer" }, PeopleRules.RolesFor("owner"));
        Assert.Equal(new[] { "admin", "member", "viewer" }, PeopleRules.RolesFor("admin"));
        Assert.True(PeopleRules.CanEditMember("owner", "owner", false));
        Assert.False(PeopleRules.CanEditMember("admin", "owner", false));
        Assert.True(PeopleRules.CanEditMember("admin", "member", false));
        Assert.False(PeopleRules.CanEditMember("owner", "member", true));   // not yourself
        Assert.False(PeopleRules.CanEditMember("member", "viewer", false));
        Assert.False(PeopleRules.CanEditMember("viewer", "viewer", false));
    }

    [Fact]
    public void Toasts_use_Apples_words()
    {
        Assert.Equal("Invite sent to a@b.co. You can also copy the link.", PeopleRules.InvitedToast(new InviteOutcome("invited", true, "u"), "a@b.co"));
        Assert.Equal("Invite created for a@b.co: copy the link.", PeopleRules.InvitedToast(new InviteOutcome("invited", false, "u"), "a@b.co"));
        Assert.Equal("a@b.co is a member now", PeopleRules.InvitedToast(new InviteOutcome("added", false, null), "a@b.co"));
        Assert.Equal("New link made for a@b.co: copy it.", PeopleRules.ResentToast(new InviteOutcome("invited", false, "u"), "a@b.co"));
        Assert.Equal("Owner", PeopleRules.RoleLabel("owner"));
    }
}
