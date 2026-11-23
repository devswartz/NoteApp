using Xunit;
using FlaUI.Core.Input;
using static FlaUI.Core.WindowsAPI.VirtualKeyShort;

namespace Notivelo.Windows.UiTests;

public class DiagTests
{
    [Fact]
    public void Typing_modes() => AppHost.Run(nameof(Typing_modes), h =>
    {
        h.A.Focus();
        var log = new List<string>();
        Keyboard.Type(KEY_A); Thread.Sleep(400); log.Add("vk a: " + h.A.State);
        Keyboard.Type("b"); Thread.Sleep(400); log.Add("unicode b: " + h.A.State);
        Keyboard.Press(KEY_C); Keyboard.Release(KEY_C); Thread.Sleep(400); log.Add("press/release c: " + h.A.State);
        Keyboard.Type(SPACE); Thread.Sleep(400); log.Add("space: " + h.A.State);
        Assert.Fail(string.Join(" | ", log));
    });
}
