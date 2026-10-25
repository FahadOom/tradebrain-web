package com.tradebrain.web;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.content.pm.PackageManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "KeepAlive")
public class KeepAlivePlugin extends Plugin {
    @PluginMethod public void start(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                ActivityCompat.requestPermissions(getActivity(), new String[]{Manifest.permission.POST_NOTIFICATIONS}, 9);
            Intent i = new Intent(getContext(), KeepAliveService.class);
            i.putExtra("title", call.getString("title", "TradeBrain is running")); i.putExtra("text", call.getString("text", "Scanning markets and watching open trades"));
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(i); else getContext().startService(i);
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }
    @PluginMethod public void stop(PluginCall call) {
        try { getContext().stopService(new Intent(getContext(), KeepAliveService.class)); call.resolve(); } catch (Exception e) { call.reject(e.getMessage()); }
    }
    @PluginMethod public void batteryStatus(PluginCall call) {
        JSObject o = new JSObject(); boolean ok = true;
        if (Build.VERSION.SDK_INT >= 23) { PowerManager pm = (PowerManager) getContext().getSystemService(android.content.Context.POWER_SERVICE); ok = pm.isIgnoringBatteryOptimizations(getContext().getPackageName()); }
        o.put("unrestricted", ok); call.resolve(o);
    }
    @PluginMethod public void requestUnrestricted(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); getContext().startActivity(i); call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }
}
