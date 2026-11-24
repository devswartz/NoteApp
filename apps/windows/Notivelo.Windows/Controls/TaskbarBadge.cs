using Notivelo.Windows.Data;

namespace Notivelo.Windows.Controls;

/// <summary>The taskbar badge: how many of my open tasks are due today or overdue (Apple's AppBadge; the web's dueTodayCount). A numeric badge needs package identity, so a build
/// that runs unpackaged (or a system that refuses) quietly shows none.</summary>
internal static class TaskbarBadge
{
    private static int _last = -1;

    public static void Set(int count)
    {
        count = Math.Max(0, count);
        if (count == _last) return;
        _last = count;
        try
        {
            var updater = global::Windows.UI.Notifications.BadgeUpdateManager.CreateBadgeUpdaterForApplication();
            if (count == 0) { updater.Clear(); return; }
            var doc = new global::Windows.Data.Xml.Dom.XmlDocument();
            doc.LoadXml(AuditRules.BadgeXml(count));
            updater.Update(new global::Windows.UI.Notifications.BadgeNotification(doc));
        }
        catch (Exception) { }
    }
}
