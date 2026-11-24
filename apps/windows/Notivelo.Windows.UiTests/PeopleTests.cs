using FlaUI.Core.AutomationElements;
using Xunit;

namespace Notivelo.Windows.UiTests;

/// <summary>PARITY batch 3 on the offline sample (no server): the sign-up form (checked, then the check-email screen), the workspace's members and roles, email invites
/// (made, copied, revoked) and joining by an invite link. Sign-up runs in the sign-in preview (NOTIVELO_SOURCE=signup); the rest in the offline test mode.
/// Run on the CI runner only.</summary>
public class PeopleTests
{
    private static AutomationElement Find(AppHost h, string id, int ms = 20000) =>
        AppHost.Wait(() => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)), "element " + id, ms);

    private static bool Gone(AppHost h, string id) => h.Window.FindFirstDescendant(h.Window.ConditionFactory.ByAutomationId(id)) is null;

    private static void Retry(Action a)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            try { a(); return; }
            catch (Exception) when (sw.ElapsedMilliseconds < 15000) { Thread.Sleep(200); }
        }
    }

    private static void Invoke(AppHost h, string id) => Retry(() => Find(h, id).Patterns.Invoke.Pattern.Invoke());
    private static void SetText(AppHost h, string id, string text) => Retry(() => Find(h, id).AsTextBox().Text = text);
    private static string Status(AppHost h, string id) => Find(h, id).Properties.ItemStatus.ValueOrDefault ?? "";
    private static string Log(AppHost h) => File.Exists(h.TaskLog) ? File.ReadAllText(h.TaskLog) : "";

    private static void WaitStatus(AppHost h, string id, string part) =>
        AppHost.Wait(() => Status(h, id).Contains(part) ? "x" : null, $"{id} to report {part}");

    private static AppHost LaunchSignUp() => AppHost.Launch(new Dictionary<string, string> { ["NOTIVELO_SOURCE"] = "signup" }, 1196, 859);

    private static void OpenMembers(AppHost h) { Invoke(h, "rail-workspace"); Invoke(h, "menu-members"); Find(h, "members-dialog"); WaitStatus(h, "members-dialog", "members=4"); }

    [Fact]
    public void Sign_up_checks_the_form_then_shows_check_your_email()
    {
        using var h = LaunchSignUp();
        try
        {
            Find(h, "signin");
            Invoke(h, "signin-toggle-mode");
            Find(h, "signup");
            Invoke(h, "signin-submit");
            Assert.Contains("Enter your name, email and a password.", Find(h, "signin-error").Name);
            SetText(h, "signup-name", "Demo User");
            SetText(h, "signin-email", "demo@example.com");
            Retry(() => { Find(h, "signin-password").Focus(); h.Type("short"); });
            Invoke(h, "signin-submit");
            AppHost.Wait(() => Find(h, "signin-error").Name.Contains("8 to 72") ? "x" : null, "the password length problem");
            Find(h, "signin-password").Focus(); h.Type("er-than-eight");   // "shorter-than-eight": 18 characters
            Invoke(h, "signin-submit");
            Find(h, "check-email");
            Assert.Contains("demo@example.com", Find(h, "check-email-text").Name);
            Invoke(h, "check-email-continue");
            AppHost.Wait(() => Find(h, "check-email-info").Name.StartsWith("Not confirmed yet") ? "x" : null, "the not-confirmed note");
            Invoke(h, "check-email-signout");
            Find(h, "signin");
        }
        catch { h.Shot(nameof(Sign_up_checks_the_form_then_shows_check_your_email)); throw; }
    }

    [Fact]
    public void Members_dialog_lists_people_and_changes_a_role() => AppHost.Run(nameof(Members_dialog_lists_people_and_changes_a_role), h =>
    {
        OpenMembers(h);
        WaitStatus(h, "members-dialog", "invites=1");
        Invoke(h, "member-role-u2");
        Invoke(h, "member-role-opt-admin");
        WaitStatus(h, "member-role-u2", "role=admin");
        Assert.Contains("people role Sam Rivera admin", Log(h));
        Invoke(h, "member-remove-u4");
        WaitStatus(h, "members-dialog", "members=3");
        Assert.Contains("people remove Lee Chen", Log(h));
        Assert.True(Gone(h, "member-remove-u1"));                 // not yourself
    });

    [Fact]
    public void Invite_by_email_shows_a_link_to_copy_and_can_be_revoked() => AppHost.Run(nameof(Invite_by_email_shows_a_link_to_copy_and_can_be_revoked), h =>
    {
        OpenMembers(h);
        SetText(h, "members-invite-email", "not an email");
        Assert.False(Find(h, "members-invite-submit").IsEnabled);
        SetText(h, "members-invite-email", "casey@example.com");
        AppHost.Wait(() => Find(h, "members-invite-submit").IsEnabled ? "x" : null, "Invite enabled");
        Invoke(h, "members-invite-submit");
        Assert.Contains("invite/sample-link-", Find(h, "members-invite-url").Name);
        WaitStatus(h, "members-dialog", "invites=2");
        Assert.Contains("people invite casey@example.com member", Log(h));
        Invoke(h, "members-invite-copy");
        WaitStatus(h, "members-invite-copy", "copied=1");
        Invoke(h, "invite-revoke-casey-example-com");
        WaitStatus(h, "members-dialog", "invites=1");
        Invoke(h, "invite-resend-jordan-example-com");
        Assert.Contains("people resend jordan@example.com", Log(h));
        Invoke(h, "members-leave");
        Invoke(h, "members-leave-confirm");
        Assert.Contains("at least one owner", Find(h, "members-error").Name);
    });

    [Fact]
    public void Join_with_a_pasted_invite_link() => AppHost.Run(nameof(Join_with_a_pasted_invite_link), h =>
    {
        Invoke(h, "rail-workspace"); Invoke(h, "menu-join-invite"); Find(h, "join-dialog");
        SetText(h, "join-input", "https://app.example.com/invite/gone");
        Invoke(h, "join-continue");
        Assert.Contains("no longer valid", Find(h, "join-error").Name);
        SetText(h, "join-input", "https://app.example.com/invite/sample-invite");
        Invoke(h, "join-continue");
        Find(h, "join-info");
        WaitStatus(h, "join-dialog", "step=accept");
        Invoke(h, "join-continue");
        AppHost.Wait(() => Gone(h, "join-dialog") ? "x" : null, "the dialog closed");
        Assert.Contains("people accept sample-invite", Log(h));
    });
}
