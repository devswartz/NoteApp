using Notivelo.Native;

namespace Notivelo.Windows.Tests;

/// <summary>Builds line-table rows the way the core would hand them over.</summary>
internal static class Lines
{
    public static ViewMark M(ViewMarkKind k, string? v = null) => new(k, v);
    public static ViewRun R(int from, int len, params ViewMark[] marks) => new((uint)from, (uint)len, marks);

    public static ViewLine Ln(int offset, string text, string kind = "paragraph", string[]? containers = null, string? marker = null,
        bool? check = null, byte level = 0, ViewRun[]? runs = null) =>
        new((uint)offset, (uint)text.Length, (uint)offset, true, kind, level, containers ?? Array.Empty<string>(), marker, check, null,
            runs ?? Array.Empty<ViewRun>(), Array.Empty<ViewAtom>(), null);

    public static ViewLine Obj(int offset, string kind, string[]? containers = null, string? taskId = null, string? attrs = null) =>
        new((uint)offset, 1, (uint)offset, false, kind, 0, containers ?? Array.Empty<string>(), null, null, taskId,
            Array.Empty<ViewRun>(), Array.Empty<ViewAtom>(), attrs);
}
