package com.devswartz.noteapp;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * "Today" home-screen widget: my open tasks due today or overdue, from the
 * snapshot the app writes (NoteAppNativePlugin.writeWidgetSnapshot; format:
 * WidgetSnapshot in src/platform/capacitor.ts). Tapping opens Today; tapping a
 * row opens that task.
 */
public class TodayWidgetProvider extends AppWidgetProvider {
    static final String PREFS = "noteapp_widget";
    static final String KEY = "snapshot";
    private static final int[] ROWS = { R.id.row1, R.id.row2, R.id.row3, R.id.row4, R.id.row5 };

    /** Saves a new snapshot and redraws every placed widget. */
    static void update(Context context, String json) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply();
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, TodayWidgetProvider.class));
        for (int id : ids) mgr.updateAppWidget(id, render(context, json));
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String json = prefs.getString(KEY, null);
        for (int id : ids) mgr.updateAppWidget(id, render(context, json));
    }

    private static PendingIntent open(Context context, String path, int requestCode) {
        Uri uri = Uri.parse(path != null && path.startsWith("/") ? "noteapp:/" + path : "noteapp://");
        Intent intent = new Intent(Intent.ACTION_VIEW, uri, context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static RemoteViews render(Context context, String json) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.today_widget);
        for (int row : ROWS) views.setViewVisibility(row, View.GONE);
        views.setViewVisibility(R.id.empty, View.VISIBLE);
        views.setTextViewText(R.id.count, "");
        String path = null;
        try {
            JSONObject snap = json == null ? null : new JSONObject(json);
            if (snap == null || !snap.optBoolean("signedIn")) {
                views.setTextViewText(R.id.empty, context.getString(R.string.widget_signed_out));
            } else {
                path = snap.optString("path", null);
                String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
                boolean stale = !today.equals(snap.optString("date"));
                JSONArray items = snap.optJSONArray("items");
                int n = items == null ? 0 : Math.min(items.length(), ROWS.length);
                views.setTextViewText(R.id.count, String.valueOf(snap.optInt("total")));
                views.setTextViewText(R.id.empty, context.getString(R.string.widget_all_clear));
                if (n > 0) views.setViewVisibility(R.id.empty, View.GONE);
                for (int i = 0; i < n; i++) {
                    JSONObject item = items.getJSONObject(i);
                    String suffix = item.optBoolean("overdue") || stale
                        ? "  · " + context.getString(R.string.widget_overdue)
                        : (item.isNull("time") ? "" : "  · " + item.optString("time"));
                    views.setTextViewText(ROWS[i], "○  " + item.optString("title") + suffix);
                    views.setViewVisibility(ROWS[i], View.VISIBLE);
                    views.setOnClickPendingIntent(ROWS[i], open(context, item.optString("path", path), 100 + i));
                }
            }
        } catch (Exception e) {
            views.setTextViewText(R.id.empty, context.getString(R.string.widget_signed_out));
        }
        views.setOnClickPendingIntent(R.id.widget_root, open(context, path, 1));
        return views;
    }
}
