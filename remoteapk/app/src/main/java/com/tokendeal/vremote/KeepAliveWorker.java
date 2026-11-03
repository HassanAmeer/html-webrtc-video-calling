package com.tokendeal.vremote;

import android.content.Context;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import io.socket.client.IO;
import io.socket.client.Socket;
import org.json.JSONObject;

/**
 * 30-minute Background KeepAlive Worker powered by Android Jetpack WorkManager.
 * Ensures the device auto-reconnects, refreshes registration on v.tokendeal.cloud,
 * and remains controllable even if the main UI was stopped or swiped away.
 */
public class KeepAliveWorker extends Worker {
    private static final String TAG = "KeepAliveWorker";
    private static final String SERVER_URL = "https://v.tokendeal.cloud";

    public KeepAliveWorker(@NonNull Context context, @NonNull WorkerParameters workerParams) {
        super(context, workerParams);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        Log.i(TAG, "KeepAliveWorker triggered (30-minute periodic check)");

        try {
            final String deviceId = DeviceRegistry.getDeviceId(context);
            final String deviceName = DeviceRegistry.getDeviceModel();
            final String ram = DeviceRegistry.getDeviceRam(context);

            IO.Options opts = new IO.Options();
            opts.reconnection = false;
            opts.timeout = 10000;
            opts.transports = new String[]{"websocket", "polling"};

            final Socket pingSocket = IO.socket(SERVER_URL, opts);

            pingSocket.on(Socket.EVENT_CONNECT, args -> {
                try {
                    JSONObject payload = new JSONObject();
                    payload.put("deviceId", deviceId);
                    payload.put("deviceName", deviceName);
                    payload.put("ram", ram);
                    payload.put("platform", "android");
                    payload.put("role", "keepalive_worker");

                    pingSocket.emit("register-device", payload);
                    Log.i(TAG, "KeepAlive registration ping emitted for device: " + deviceId);

                    new Thread(() -> {
                        try { Thread.sleep(3500); } catch (InterruptedException ignored) {}
                        try { pingSocket.disconnect(); } catch (Exception ignored) {}
                    }).start();
                } catch (Exception e) {
                    Log.e(TAG, "Error emitting keepAlive payload", e);
                }
            });

            pingSocket.connect();

            // Allow socket communication up to 5 seconds
            Thread.sleep(5000);

        } catch (Exception e) {
            Log.e(TAG, "Error in KeepAliveWorker execution", e);
            return Result.retry();
        }

        return Result.success();
    }
}
