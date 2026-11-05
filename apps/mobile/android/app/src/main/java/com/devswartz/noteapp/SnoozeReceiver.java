package com.devswartz.noteapp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.core.app.NotificationManagerCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * Snooze action on a reminder notification: POST /api/reminders/snooze with the
 * notification's one-time snooze token (no sign-in needed), then dismiss the
 * notification. The server URL is written by the web app
 * (NoteAppNative.setConfig, src/platform/capacitor.ts).
 */
public class SnoozeReceiver extends BroadcastReceiver {
    static final String EXTRA_TOKEN = "snoozeToken";
    static final String EXTRA_OPTION = "option";
    static final String EXTRA_NOTIFICATION = "notificationId";
    static final String PREFS = "noteapp_config";

    static String apiBase(Context context) {
        String base = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("apiBase", null);
        return base != null && (base.startsWith("https://") || base.startsWith("http://localhost") || base.startsWith("http://10.0.2.2")) ? base : null;
    }

    static void setApiBase(Context context, String base) {
        SharedPreferences.Editor e = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (base == null) e.remove("apiBase");
        else e.putString("apiBase", base.replaceAll("/+$", ""));
        e.apply();
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        final String token = intent.getStringExtra(EXTRA_TOKEN);
        final String option = intent.getStringExtra(EXTRA_OPTION);
        final int notificationId = intent.getIntExtra(EXTRA_NOTIFICATION, 0);
        final String base = apiBase(context);
        if (token == null || option == null || base == null) return;
        final PendingResult pending = goAsync();
        final Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/reminders/snooze").openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(10_000);
                c.setReadTimeout(10_000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                JSONObject body = new JSONObject();
                body.put("token", token);
                body.put("option", option);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int status = c.getResponseCode();
                c.disconnect();
                if (status >= 200 && status < 300) NotificationManagerCompat.from(app).cancel(notificationId);
            } catch (Exception ignored) {
                // Offline: leave the notification so the user can try again or open the task.
            } finally {
                pending.finish();
            }
        }).start();
    }
}
