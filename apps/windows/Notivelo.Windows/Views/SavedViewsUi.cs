using Microsoft.UI.Xaml;
using Notivelo.Windows.Controls;
using Notivelo.Windows.Data;

namespace Notivelo.Windows.Views;

/// <summary>The menus and forms of saved task views (Apple's SavedViewsMenu / SavedViewDialog, the web's savedViews.ts): the Tasks ribbon's Saved views menu, a view's row menu
/// in the sidebar, and the name forms. A view keeps the filters, sort and group of All tasks; opening one shows All tasks with them. Every call goes through the source,
/// off the UI thread, and an error is shown as a toast.</summary>
internal static class SavedViewsUi
{
    private static string? Me(ShellHost h) => h.Source.UserId;

    /// <summary>"Save view…": a name form; the view is made with the conditions of <paramref name="state"/>.</summary>
    public static void Save(ShellHost h, TaskViewState state)
    {
        if (!h.Source.CanSaveViews) { h.Toast("Saved views aren't available here.", true); return; }
        var first = SavedViewRules.FreeName(h.Source.SavedViews, "My view");
        Dialogs.Prompt(h.Overlay, "Save view", "Name", first, "Save", async name =>
        {
            var r = await h.Source.CreateSavedView(name, SavedViewRules.ToQueryJson(state), false);
            if (!r.Ok) return r.Error;
            h.Toast("View saved");
            return null;
        });
    }

    public static void Rename(ShellHost h, SavedView v) =>
        Dialogs.Prompt(h.Overlay, "Rename view", "Name", v.Name, "Rename", async name =>
        {
            var err = await h.Source.UpdateSavedView(v.Id, name: name);
            if (err is null) h.Toast("View renamed");
            return err;
        });

    public static void Delete(ShellHost h, SavedView v) =>
        Dialogs.Confirm(h.Overlay, "Delete view?", $"“{v.Name}” is deleted for " + (v.Shared ? "everyone it is shared with. The tasks stay." : "you. The tasks stay."), "Delete", true, async () =>
        {
            var err = await h.Source.DeleteSavedView(v.Id);
            if (err is null) h.Toast("View deleted");
            return err;
        });

    private static async void Update(ShellHost h, SavedView v, string? query = null, bool? shared = null, string? done = null)
    {
        var err = await h.Source.UpdateSavedView(v.Id, queryJson: query, shared: shared);
        h.Toast(err ?? done ?? "View updated", err is not null);
    }

    /// <summary>The row menu of a saved view: open, rename, update to the filters on screen, share, delete. <paramref name="current"/> is All tasks' conditions (null: not on All tasks).</summary>
    public static void RowMenu(ShellHost h, FrameworkElement anchor, SavedView v, TaskViewState? current)
    {
        var items = new List<MenuEntry>
        {
            new("Open", "list-checks", () => h.OpenSavedView(v), Id: "menu-view-open"),
            new("Rename…", "pencil", () => Rename(h, v), Id: "menu-view-rename"),
        };
        if (current is not null && !SavedViewRules.Same(current, v.QueryJson))
            items.Add(new("Update to the filters on screen", "rotate-cw", () => Update(h, v, query: SavedViewRules.ToQueryJson(current), done: "View updated"), Id: "menu-view-update"));
        if (h.Source.WorkspaceRole is "owner" or "admin")
            items.Add(new(v.Shared ? "Only me" : "Share with the workspace", v.Shared ? "user" : "users-round", () => Update(h, v, shared: !v.Shared, done: v.Shared ? "Only you see this view" : "Shared with the workspace"), Id: "menu-view-share"));
        items.Add(MenuEntry.Sep());
        items.Add(new("Delete view…", "trash", () => Delete(h, v), Danger: true, Id: "menu-view-delete"));
        PopupMenu.Show(h.Overlay, items, anchor, endAlign: true, id: "menu-view");
    }

    /// <summary>The Tasks ribbon's Saved views menu: the views (a tick on the one on screen), then New view and Save view.</summary>
    public static void RibbonMenu(ShellHost h, FrameworkElement anchor, TaskViewState? current, bool onAll)
    {
        h.Source.LoadSavedViews();
        var items = new List<MenuEntry>();
        var views = SavedViewRules.Ordered(h.Source.SavedViews, Me(h));
        var now = current is null || !onAll ? null : SavedViewRules.Matching(views, current);
        if (views.Count == 0) items.Add(new("No saved views yet", Id: "menu-views-none"));
        foreach (var v in views) items.Add(new(v.Name, v.Shared ? "users-round" : "bookmark", () => h.OpenSavedView(v), Check: now?.Id == v.Id, Id: "menu-view-" + v.Id));
        items.Add(MenuEntry.Sep());
        items.Add(new("New view", "plus", () => h.NewTasksView(), Id: "menu-views-new"));
        if (onAll && current is { IsDefault: false }) items.Add(new("Save the filters as a view…", "bookmark-plus", () => Save(h, current), Id: "menu-views-save"));
        PopupMenu.Show(h.Overlay, items, anchor, id: "menu-saved-views", width: 260);
    }
}
