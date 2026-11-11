package com.devswartz.notivelo;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * App-specific native bits used by src/platform/capacitor.ts.
 *
 * Share capture: other apps' share sheets show two targets, "Add task" and
 * "Save as note" (activity-aliases of MainActivity in AndroidManifest.xml).
 * Shared text/links are queued here until the web app asks for them.
 *
 * Today widget: writeWidgetSnapshot() stores the snapshot TodayWidgetProvider draws.
 */
@CapacitorPlugin(name = "NoteAppNative")
public class NoteAppNativePlugin extends Plugin {
    private static final Pattern URL = Pattern.compile("https?://\\S+");
    private final List<JSObject> pending = new ArrayList<>();

    @Override
    public void load() {
        capture(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (capture(intent)) notifyListeners("shareReceived", new JSObject());
    }

    private synchronized boolean capture(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return false;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) return false;
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        ComponentName c = intent.getComponent();
        String kind = c != null && c.getClassName().endsWith(".ShareAsNote") ? "note" : "task";

        JSObject item = new JSObject();
        item.put("kind", kind);
        text = text.trim();
        Matcher m = URL.matcher(text);
        if (m.find()) {
            item.put("url", m.group());
            text = (text.substring(0, m.start()) + text.substring(m.end())).trim();
        }
        if (text.length() > 20000) text = text.substring(0, 20000);
        item.put("text", text);
        if (subject != null && !subject.trim().isEmpty()) item.put("title", subject.trim());
        pending.add(item);
        // Don't capture the same share again if the activity is recreated.
        intent.setAction(Intent.ACTION_MAIN);
        intent.removeExtra(Intent.EXTRA_TEXT);
        return true;
    }

    /** Stores the Today snapshot for the home-screen widget and redraws it. */
    @PluginMethod
    public void writeWidgetSnapshot(PluginCall call) {
        String json = call.getString("json");
        if (json == null) {
            call.reject("json is required");
            return;
        }
        TodayWidgetProvider.update(getContext(), json);
        call.resolve();
    }

    /** Settings the native side needs without the web view (the API origin, for snooze actions). */
    @PluginMethod
    public void setConfig(PluginCall call) {
        SnoozeReceiver.setApiBase(getContext(), call.getString("apiBase"));
        call.resolve();
    }

    /**
     * Prints the web view (Android's WebView ignores window.print()): PrintManager with the
     * WebView's print adapter, which lays the page out with the print stylesheet. The system
     * dialog offers printers and "Save as PDF". Resolves once the job is handed to the system.
     */
    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("jobName", "Note");
        getActivity().runOnUiThread(() -> {
            PrintManager pm = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
            WebView webView = getBridge().getWebView();
            if (pm == null || webView == null) {
                call.reject("Printing is not available");
                return;
            }
            PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(name);
            pm.print(name, adapter, new PrintAttributes.Builder().build());
            call.resolve();
        });
    }

    /** Shared items received since the last call. */
    @PluginMethod
    public synchronized void getPendingShares(PluginCall call) {
        JSArray items = new JSArray();
        for (JSObject o : pending) items.put(o);
        pending.clear();
        JSObject ret = new JSObject();
        ret.put("items", items);
        call.resolve(ret);
    }
}
