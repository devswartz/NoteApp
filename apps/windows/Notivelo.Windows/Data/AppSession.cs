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
    /// <summary>The shell was opened from the data stored on this device because the server could not be reached: the session is not confirmed yet and is tried again in the background.</summary>
    public bool Unconfirmed { get; private set; }
    public N.User? User { get; private set; }
    public CoreNotesSource? Source { get; private set; }
    public event Action? Changed;

    /// <summary>Preview mode (NOTIVELO_SOURCE=signup, for screenshots and UI tests): the sign-in and sign-up screens with no server and no stored sign-in;
    /// sign-up goes to the check-email screen on a fake success.</summary>
    public bool Preview { get; }

    public AppSession(bool preview = false)
    {
        Preview = preview;
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
            if (await TryOpenOfflineAsync(core, e)) return;
            Phase = SessionPhase.SignedOut;
            if (ErrorText.TokenRejected(e))
            {
                CredentialStore.Delete(ServerUrl); AppSettings.ClearLastUser(ServerUrl); CanRetryRestore = false; Error = "You were signed out. Sign in again.";
            }
            else { CanRetryRestore = true; Error = ErrorText.Message(e); }
            Raise();
        }
    }

    /// <summary>No network at launch: open the shell from the stored workspaces, tree and tasks (the Offline save state shows) and keep trying to restore the sign-in.</summary>
    private async Task<bool> TryOpenOfflineAsync(N.Core core, Exception failure)
    {
        if (failure is not N.CoreException.Network) return false;
        int cached;
        try { cached = (await RunAsync(core, c => c.CachedWorkspaces()))?.Length ?? 0; } catch { return false; }
        if (core != _core) return true;
        if (OfflineStart.Decide(failure, cached, OfflineStart.Decode(AppSettings.LastUser(ServerUrl))) is not { } user) return false;
        User = user; Error = null; CanRetryRestore = false; Unconfirmed = true;
        Phase = SessionPhase.SignedIn;
        Source = new CoreNotesSource(this, user);
        Raise();
        Source.Start();
        _ = KeepTryingAsync(core);
        return true;
    }

    /// <summary>Restore the kept sign-in again until it works (then the shell goes live) or is rejected (then back to the sign-in screen).</summary>
    private async Task KeepTryingAsync(N.Core core)
    {
        for (var attempt = 0; ; attempt++)
        {
            await Task.Delay(OfflineStart.RetryDelay(attempt));
            if (core != _core || Phase != SessionPhase.SignedIn || !Unconfirmed) return;
            var token = CredentialStore.Read(ServerUrl);
            if (token is null) { EndSession(null); return; }
            try
            {
                var (signedIn, latest) = await RunAsync(core, c => (c.RestoreSession(token), c.RefreshToken()));
                if (core != _core || !Unconfirmed) return;
                Unconfirmed = false;
                DidSignIn(signedIn.User, latest ?? signedIn.RefreshToken);
                Source?.GoLive();
                return;
            }
            catch (Exception e)
            {
                if (core != _core) return;
                if (OfflineStart.GiveUp(ErrorText.TokenRejected(e))) { CredentialStore.Delete(ServerUrl); AppSettings.ClearLastUser(ServerUrl); EndSession("You were signed out. Sign in again."); return; }
            }
        }
    }

    /// <summary>Signed in but the address is not confirmed yet: the "Check your email" screen stands in for the app (the server refuses everything else with 403 email_unverified).</summary>
    public bool NeedsEmailCheck => Phase == SessionPhase.SignedIn && User is { EmailVerified: false };

    public void ClearError() { if (Error is null) return; Error = null; Raise(); }

    /// <summary>Create an account (core <c>register</c>) and sign in to it; the server then wants the address confirmed (<see cref="NeedsEmailCheck"/>).</summary>
    public async void Register(string name, string email, string password)
    {
        name = name.Trim(); email = email.Trim();
        if (PeopleRules.SignUpProblem(name, email, password) is { } problem) { Error = problem; Raise(); return; }
        Busy = true; Error = null; Raise();
        if (Preview)
        {
            await Task.Delay(150);
            Busy = false;
            User = new N.User("preview", email, name, "#6366f1", false);
            Phase = SessionPhase.SignedIn; Raise();
            return;
        }
        var core = _core;
        try
        {
            var (signedIn, latest) = await RunAsync(core, c => (c.Register(name, email, password), c.RefreshToken()));
            if (core != _core) return;
            Busy = false;
            DidSignIn(signedIn.User, latest ?? signedIn.RefreshToken);
        }
        catch (Exception e)
        {
            if (core != _core) return;
            Busy = false; Error = ErrorText.Message(e); Raise();
        }
    }

    /// <summary>"I've verified, continue": ask the server again (the kept sign-in carries the user as it is now). Calls <paramref name="done"/> on the UI thread with a
    /// sentence to show, or null when the address is confirmed (the app follows).</summary>
    public async void RecheckEmail(Action<string?> done)
    {
        const string NotYet = "Not confirmed yet. Open the link in the email we sent, then try again.";
        if (Preview) { await Task.Delay(150); done(NotYet); return; }
        var token = _savedToken ?? CredentialStore.Read(ServerUrl);
        if (token is null) { done("Sign in again."); return; }
        var core = _core;
        try
        {
            var (signedIn, latest) = await RunAsync(core, c => (c.RestoreSession(token), c.RefreshToken()));
            if (core != _core) return;
            DidSignIn(signedIn.User, latest ?? signedIn.RefreshToken);
            done(signedIn.User.EmailVerified ? null : NotYet);
        }
        catch (Exception e)
        {
            if (core != _core) return;
            done(ErrorText.Message(e));
        }
    }

    public async void SignIn(string email, string password)
    {
        if (Preview) { Error = "Sign-in is not available in this preview."; Raise(); return; }
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
        if (!Preview) { _ = Task.Run(() => { try { core.SignOut(); } catch { } }); CredentialStore.Delete(ServerUrl); AppSettings.ClearLastUser(ServerUrl); }
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
        if (!Preview) AppSettings.SetLastUser(ServerUrl, OfflineStart.Encode(user));
        User = user; Error = null; CanRetryRestore = false; Unconfirmed = false;
        Phase = SessionPhase.SignedIn;
        if (!user.EmailVerified) { Source?.Dispose(); Source = null; Raise(); return; }   // the check-email screen; no data calls until confirmed
        if (Source is not null) { Raise(); return; }
        Source = new CoreNotesSource(this, user);
        Raise();
        Source.Start();
    }

    private void EndSession(string? message)
    {
        Source?.Dispose();
        Source = null; User = null; _savedToken = null; Busy = false; CanRetryRestore = false; Unconfirmed = false;
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
            // opened from the stored data and not signed in yet: the server saying so means nothing; the background restore decides
            if (core == _core && Phase == SessionPhase.SignedIn && !Unconfirmed)
            {
                CredentialStore.Delete(ServerUrl); AppSettings.ClearLastUser(ServerUrl);
                EndSession(ErrorText.Message(e));
            }
            throw;
        }
    }

    internal void Post(Action a) { if (!_ui.TryEnqueue(() => a())) { } }
}
