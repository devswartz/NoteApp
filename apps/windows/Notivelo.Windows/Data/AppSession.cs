using Microsoft.UI.Dispatching;
using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

internal enum SessionPhase { Restoring, SignedOut, SignedIn }

/// <summary>
/// The signed-in session: one core for the chosen server, the refresh token in the Credential Locker, and the
/// <see cref="CoreNotesSource"/> once signed in. Core calls block (HTTP, SQLite), so they run one at a time on the thread pool
/// (<see cref="CallAsync"/>) and continue on the UI thread; after each call the rotating refresh token is stored again.
/// Server: production by default; env NOTIVELO_SERVER overrides it (dev/staging); long-press the version line on the sign-in
/// screen to switch between production and staging.
/// </summary>
internal sealed class AppSession
{
    public const string Production = "https://app.notiveloapp.com";
    public const string Staging = "https://staging.notiveloapp.com";

    private readonly DispatcherQueue _ui = DispatcherQueue.GetForCurrentThread();
    private readonly SemaphoreSlim _gate = new(1, 1);
    private N.Core _core;
    private string? _savedToken;

    public string ServerUrl { get; private set; }
    public bool ServerFixedByEnv { get; }
    public SessionPhase Phase { get; private set; } = SessionPhase.SignedOut;
    public string? Error { get; private set; }
    public bool Busy { get; private set; }
    /// <summary>A kept sign-in that could not be resumed (offline, say): the sign-in screen offers to try again.</summary>
    public bool CanRetryRestore { get; private set; }
    public N.User? User { get; private set; }
    public CoreNotesSource? Source { get; private set; }
    public event Action? Changed;

    public AppSession()
    {
        var env = Environment.GetEnvironmentVariable("NOTIVELO_SERVER")?.Trim().TrimEnd('/');
        ServerFixedByEnv = !string.IsNullOrEmpty(env);
        ServerUrl = ServerFixedByEnv ? env! : AppSettings.Staging ? Staging : Production;
        _core = MakeCore(ServerUrl);
    }

    public bool IsProduction => ServerUrl == Production;
    public string Host => Uri.TryCreate(ServerUrl, UriKind.Absolute, out var u) ? u.Authority : ServerUrl;

    /// <summary>One file per server in %LOCALAPPDATA%\Notivelo\Store (the core reads it offline and keeps queued edits). Without a usable folder: no store.</summary>
    private static N.Core MakeCore(string url)
    {
        try
        {
            var dir = Path.Combine(AppSettings.Folder, "Store");
            Directory.CreateDirectory(dir);
            var host = Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Authority.Replace(':', '-') : "server";
            return N.Core.WithStore(url, Path.Combine(dir, $"notivelo-{host}.sqlite"));
        }
        catch { return new N.Core(url); }
    }

    private void Raise() => Changed?.Invoke();

    // ---- sign-in ----------------------------------------------------------------------------------------------

    /// <summary>Resume the sign-in kept for this server, if any.</summary>
    public async void Restore()
    {
        var token = CredentialStore.Read(ServerUrl);
        if (token is null) { Phase = SessionPhase.SignedOut; CanRetryRestore = false; Raise(); return; }
        Phase = SessionPhase.Restoring; Error = null; Raise();
        var core = _core;
        try
        {
            var (signedIn, latest) = await RunAsync(core, c => (c.RestoreSession(token), c.RefreshToken()));
            if (core != _core) return;
            DidSignIn(signedIn.User, latest ?? signedIn.RefreshToken);
        }
        catch (Exception e)
        {
            if (core != _core) return;
            Phase = SessionPhase.SignedOut;
            if (ErrorText.TokenRejected(e))
            {
                CredentialStore.Delete(ServerUrl); CanRetryRestore = false; Error = "You were signed out. Sign in again.";
            }
            else { CanRetryRestore = true; Error = ErrorText.Message(e); }
            Raise();
        }
    }

    public async void SignIn(string email, string password)
    {
        email = email.Trim();
        if (email.Length == 0 || password.Length == 0) { Error = "Enter your email and password."; Raise(); return; }
        Busy = true; Error = null; Raise();
        var core = _core;
        try
        {
            var (signedIn, latest) = await RunAsync(core, c => (c.SignIn(email, password), c.RefreshToken()));
            if (core != _core) return;
            Busy = false;
            DidSignIn(signedIn.User, latest ?? signedIn.RefreshToken);
        }
        catch (Exception e)
        {
            if (core != _core) return;
            Busy = false; Error = ErrorText.Message(e, signingIn: true); Raise();
        }
    }

    public void SignOut()
    {
        var core = _core;
        _ = Task.Run(() => { try { core.SignOut(); } catch { } });
        CredentialStore.Delete(ServerUrl);
        EndSession(null);
    }

    /// <summary>The hidden staging switch (not offered when NOTIVELO_SERVER sets the server).</summary>
    public void ToggleStaging()
    {
        if (Phase == SessionPhase.SignedIn || ServerFixedByEnv) return;
        var staging = IsProduction;
        AppSettings.Staging = staging;
        ServerUrl = staging ? Staging : Production;
        _core = MakeCore(ServerUrl);
        Error = null;
        Restore();
        Raise();
    }

    private void DidSignIn(N.User user, string token)
    {
        Store(token);
        User = user; Error = null; CanRetryRestore = false;
        Source = new CoreNotesSource(this, user);
        Phase = SessionPhase.SignedIn;
        Raise();
        Source.Start();
    }

    private void EndSession(string? message)
    {
        Source?.Dispose();
        Source = null; User = null; _savedToken = null; Busy = false; CanRetryRestore = false;
        _core = MakeCore(ServerUrl);
        Error = message; Phase = SessionPhase.SignedOut;
        Raise();
    }

    /// <summary>Keep a refresh token the core handed back outside a plain call (a password change makes the old one useless).</summary>
    public void KeepToken(string token) => Store(token);

    private void Store(string? token)
    {
        if (token is null || token == _savedToken) return;
        CredentialStore.Write(ServerUrl, token);
        _savedToken = token;
    }

    // ---- core calls -------------------------------------------------------------------------------------------

    internal N.Core Core => _core;

    private async Task<T> RunAsync<T>(N.Core core, Func<N.Core, T> work)
    {
        await _gate.WaitAsync();
        try { return await Task.Run(() => work(core)); }
        finally { _gate.Release(); }
    }

    /// <summary>Run <paramref name="work"/> on the pool, one call at a time, and continue on the UI thread. A call that finds the
    /// session gone ends it here (back to the sign-in screen).</summary>
    public async Task<T> CallAsync<T>(Func<N.Core, T> work)
    {
        var core = _core;
        if (Phase != SessionPhase.SignedIn) throw new OperationCanceledException();
        try
        {
            var (result, latest) = await RunAsync(core, c => { var r = work(c); return (r, c.RefreshToken()); });
            if (core != _core || Phase != SessionPhase.SignedIn) throw new OperationCanceledException();
            Store(latest);
            return result;
        }
        catch (N.CoreException.SignedOut e)
        {
            if (core == _core && Phase == SessionPhase.SignedIn)
            {
                CredentialStore.Delete(ServerUrl);
                EndSession(ErrorText.Message(e));
            }
            throw;
        }
    }

    internal void Post(Action a) { if (!_ui.TryEnqueue(() => a())) { } }
}
