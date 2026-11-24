using N = Notivelo.Native;

namespace Notivelo.Windows.Data;

/// <summary>Core errors as one sentence for the screen.</summary>
internal static class ErrorText
{
    public static string Message(Exception e, bool signingIn = false)
    {
        switch (e)
        {
            case N.CoreException.SignedOut:
                return "You were signed out. Sign in again.";
            case N.CoreException.Network:
                return "Can't reach the server. Check your connection and try again.";
            case N.CoreException.Server s:
                if (signingIn && (s.status == 401 || s.status == 400)) return "Wrong email or password.";
                if (s.status == 429) return "Too many tries. Wait a moment and try again.";
                return string.IsNullOrWhiteSpace(s.message) ? $"The server answered {s.status}." : s.message;
            case N.CoreException.InvalidPage p:
                return p.message;
            default:
                return e.Message;
        }
    }

    /// <summary>A failed upload or download as one sentence (Text/MediaRules.UploadError has the wording).</summary>
    public static string Media(Exception e, string name) => e switch
    {
        N.CoreException.Network => Notivelo.Windows.Text.MediaRules.UploadError(null, null, null, name, true),
        N.CoreException.Server s => Notivelo.Windows.Text.MediaRules.UploadError(s.status, s.code, s.message, name, false),
        _ => Message(e),
    };

    public static bool TokenRejected(Exception e) => e switch
    {
        N.CoreException.SignedOut => true,
        N.CoreException.Server s => s.status is 401 or 403,
        _ => false,
    };
}
