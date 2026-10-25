#!/usr/bin/env bash
# Adds the background keep-alive (foreground service) to the generated Android project. Run from the repo root after `npx cap add android`.
set -e
D=android/app/src/main/java/com/tradebrain/web
mkdir -p "$D"
cp native/KeepAliveService.java native/KeepAlivePlugin.java native/MainActivity.java "$D/"
python3 - <<'PY'
import re
p='android/app/src/main/AndroidManifest.xml'; s=open(p).read()
perms=['FOREGROUND_SERVICE','FOREGROUND_SERVICE_SPECIAL_USE','POST_NOTIFICATIONS','WAKE_LOCK','REQUEST_IGNORE_BATTERY_OPTIMIZATIONS','INTERNET']
add=''.join('    <uses-permission android:name="android.permission.%s" />\n'%x for x in perms if 'android.permission.%s"'%x not in s)
s=s.replace('<application',add+'    <application',1) if add else s
svc='''        <service android:name=".KeepAliveService" android:exported="false" android:foregroundServiceType="specialUse">
            <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="Continuous market scanning and trade supervision started by the user" />
        </service>
'''
if 'KeepAliveService' not in s: s=s.replace('</application>',svc+'    </application>',1)
open(p,'w').write(s)
PY
echo "keep-alive injected"
