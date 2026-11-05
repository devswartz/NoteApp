package com.devswartz.noteapp;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugin (share capture, widget snapshot); must be registered before super.onCreate.
        registerPlugin(NoteAppNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
