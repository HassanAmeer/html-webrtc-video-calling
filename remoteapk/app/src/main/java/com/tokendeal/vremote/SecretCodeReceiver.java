package com.tokendeal.vremote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Backup hidden entry point used to reopen the app when it is in Ghost Mode.
 * Primary method: type *7861# in the dialer (detected by RemoteAccessibilityService).
 * This receiver (*#*#7861#*#*) stays as fallback when accessibility is OFF.
 */
public class SecretCodeReceiver extends BroadcastReceiver {
    private static final String TAG = "SecretCodeReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        Log.i(TAG, "Secret code received, launching VRemote");
        try {
            Intent launch = new Intent(context, MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            context.startActivity(launch);
        } catch (Exception e) {
            Log.e(TAG, "Failed to launch MainActivity from secret code: " + e.getMessage(), e);
        }
    }
}
