package com.tradebrain.web;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
    }
    // Keep the page's timers running when the app is in the background (the foreground service keeps the process alive).
    @Override public void onPause() { super.onPause(); try { if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().resumeTimers(); } catch (Exception e) { /* ignore */ } }
    @Override public void onStop() { super.onStop(); try { if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().resumeTimers(); } catch (Exception e) { /* ignore */ } }
}
