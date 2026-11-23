using global::Windows.Security.Credentials;

namespace Notivelo.Windows.Data;

/// <summary>The refresh token in the Windows Credential Locker (PasswordVault), one entry per server. Never written anywhere else.</summary>
internal static class CredentialStore
{
    private const string Resource = "Notivelo refresh token";

    public static string? Read(string server)
    {
        try
        {
            var vault = new PasswordVault();
            var c = vault.Retrieve(Resource, server);
            c.RetrievePassword();
            return c.Password;
        }
        catch { return null; } // not found (0x80070490) or the locker is unavailable
    }

    public static void Write(string server, string token)
    {
        try { new PasswordVault().Add(new PasswordCredential(Resource, server, token)); } catch { }
    }

    public static void Delete(string server)
    {
        try
        {
            var vault = new PasswordVault();
            vault.Remove(vault.Retrieve(Resource, server));
        }
        catch { }
    }
}
