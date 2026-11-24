namespace Notivelo.Windows.Data;

/// <summary>What an upload answers: the stored path (<c>/uploads/&lt;id&gt;&lt;ext&gt;</c>, the only thing a document keeps), the name, the type the server chose and the size.</summary>
public sealed record UploadedMedia(string Url, string Name, string Mime, long Size);

/// <summary>A downloaded file.</summary>
public sealed record MediaBytes(byte[] Bytes, string Mime);

/// <summary>A media call's answer: the value, or one sentence for the screen.</summary>
public sealed record MediaResult<T>(T? Value, string? Error = null)
{
    public bool Ok => Error is null && Value is not null;
    public static MediaResult<T> Fail(string error) => new(default, error);
}
