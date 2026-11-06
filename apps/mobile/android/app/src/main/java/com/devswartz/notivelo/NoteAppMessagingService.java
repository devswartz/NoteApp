package com.devswartz.notivelo;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Reminder pushes arrive as FCM data messages (server/reminders/fcm.ts), so the
 * app builds the notification itself and can add the same snooze actions as
 * iOS: "Snooze 10 minutes", "Snooze 1 hour", "Tomorrow morning". Tapping the
 * notification opens the task (notivelo:/<path>); a snooze action is handled by
 * SnoozeReceiver without opening the app.
 *
 * Extends the push plugin's service (AndroidManifest replaces it) so the web
 * app still gets 'registration' and 'pushNotificationReceived' events.
 */
public class NoteAppMessagingService extends MessagingService {
    static final String CHANNEL = "reminders";
    static final String[][] SNOOZE = { { "10m", "Snooze 10 minutes" }, { "1h", "Snooze 1 hour" }, { "tomorrow", "Tomorrow morning" } };

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        String title = data.get("title");
        if (message.getNotification() != null || title == null) return; // shown by the system / not ours
        show(this, data);
    }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH));
        }
    }

    static int idFor(String tag) {
        return tag == null ? (int) (System.currentTimeMillis() & 0x3fffffff) : (tag.hashCode() & 0x3fffffff) + 1;
    }

    static void show(Context context, Map<String, String> data) {
        ensureChannel(context);
        String tag = data.get("tag");
        int id = idFor(tag);
        String path = data.get("url");
        Uri uri = Uri.parse(path != null && path.startsWith("/") && !path.startsWith("//") ? "notivelo:/" + path : "notivelo://");
        Intent open = new Intent(Intent.ACTION_VIEW, uri, context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_notify)
            .setColor(ContextCompat.getColor(context, R.color.notification_accent))
            .setContentTitle(data.get("title"))
            .setContentText(data.get("body"))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(data.get("body")))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(tap);

        String token = data.get("snoozeToken");
        if (token != null && SnoozeReceiver.apiBase(context) != null) {
            for (int i = 0; i < SNOOZE.length; i++) {
                Intent snooze = new Intent(context, SnoozeReceiver.class)
                    .putExtra(SnoozeReceiver.EXTRA_TOKEN, token)
                    .putExtra(SnoozeReceiver.EXTRA_OPTION, SNOOZE[i][0])
                    .putExtra(SnoozeReceiver.EXTRA_NOTIFICATION, id);
                PendingIntent pi = PendingIntent.getBroadcast(context, id * 4 + i, snooze, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                b.addAction(0, SNOOZE[i][1], pi);
            }
        }
        try {
            NotificationManagerCompat.from(context).notify(id, b.build());
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS not granted (Android 13+): nothing to show.
        }
    }
}
