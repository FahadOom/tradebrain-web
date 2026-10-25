package com.tradebrain.web;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/** Foreground service: keeps the app process alive (with a visible notification and a CPU wake lock) so the trading loop keeps running when you switch apps. */
public class KeepAliveService extends Service {
    private static final String CH = "tradebrain_keepalive";
    private PowerManager.WakeLock lock;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null && intent.getStringExtra("title") != null ? intent.getStringExtra("title") : "TradeBrain is running";
        String text = intent != null && intent.getStringExtra("text") != null ? intent.getStringExtra("text") : "Scanning markets and watching open trades";
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(new NotificationChannel(CH, "TradeBrain background", NotificationManager.IMPORTANCE_LOW));
        Intent open = new Intent(this, MainActivity.class); open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pf = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, pf);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        Notification n = b.setContentTitle(title).setContentText(text).setSmallIcon(android.R.drawable.ic_popup_sync).setOngoing(true).setContentIntent(pi).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(7001, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE); else startForeground(7001, n);
        if (lock == null) { PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE); lock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tradebrain:keepalive"); lock.setReferenceCounted(false); }
        if (!lock.isHeld()) lock.acquire();
        return START_STICKY;
    }

    @Override public void onDestroy() { if (lock != null && lock.isHeld()) lock.release(); super.onDestroy(); }
}
