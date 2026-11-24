using Notivelo.Windows.Data;
using Xunit;

namespace Notivelo.Windows.Tests;

public class AccountRulesTests
{
    [Theory]
    [InlineData("09:30", "09:30")]
    [InlineData("9:30", "09:30")]
    [InlineData("9.05", "09:05")]
    [InlineData("0930", "09:30")]
    [InlineData(" 23:59 ", "23:59")]
    [InlineData("24:00", null)]
    [InlineData("12:60", null)]
    [InlineData("noon", null)]
    [InlineData("", null)]
    public void Normalizes_times(string input, string? want) => Assert.Equal(want, AccountRules.NormalizeTime(input));

    [Fact]
    public void Name_rules()
    {
        Assert.NotNull(AccountRules.NameProblem("   "));
        Assert.Null(AccountRules.NameProblem("Devon"));
        Assert.NotNull(AccountRules.NameProblem(new string('x', 101)));
    }

    [Fact]
    public void Password_rules()
    {
        Assert.NotNull(AccountRules.PasswordProblem("", "longenough"));
        Assert.NotNull(AccountRules.PasswordProblem("old-password", "short"));
        Assert.NotNull(AccountRules.PasswordProblem("same-password", "same-password"));
        Assert.Null(AccountRules.PasswordProblem("old-password", "new-password"));
    }

    [Fact]
    public void Access_labels_and_zones()
    {
        Assert.Equal("Read and write notes", AccountRules.AccessLabel(new[] { "notes:read", "notes:write" }));
        Assert.Equal("Read notes", AccountRules.AccessLabel(new[] { "notes:read" }));
        Assert.Contains("Asia/Colombo", AccountRules.ZonesWith("Asia/Colombo"));
        Assert.Equal(AccountRules.TimeZones.Length, AccountRules.ZonesWith("Europe/London").Count);
    }

    [Fact]
    public void Initials()
    {
        Assert.Equal("DU", AccountRules.Initials("Devon Unger", "d@x.com"));
        Assert.Equal("DE", AccountRules.Initials("Devon", "d@x.com"));
        Assert.Equal("D", AccountRules.Initials("", "d@x.com"));
    }

    [Fact]
    public void Offline_result_is_not_ok()
    {
        Assert.False(AccountResult<bool>.Off().Ok);
        Assert.True(new AccountResult<bool>(true).Ok);
    }
}
