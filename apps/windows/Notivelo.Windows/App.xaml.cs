using Microsoft.UI.Xaml;

namespace Notivelo.Windows;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        InitializeComponent();
        // Dev aid: write unhandled UI exceptions where they can be read (stowed exceptions give no message otherwise).
        UnhandledException += (_, e) =>
        {
            try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "notivelo-crash.log"), e.Exception.ToString()); } catch { }
        };
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new MainWindow();
        _window.Activate();
    }
}
