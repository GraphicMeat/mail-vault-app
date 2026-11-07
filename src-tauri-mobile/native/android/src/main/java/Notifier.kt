// MailVault mobile: posts the new-mail notifications a background run answered (plan Ruling 10;
// the shell renders the text from the app's catalogs) on the `new_mail` channel, and hands a tap's
// payload `{accountId, folder, uid?}` back to the shell. A tap opens MainActivity with the payload
// as an extra; `MvNativePlugin` reads it on a cold start (`load`) or a warm one (`onNewIntent`).

package com.mailvault.mvnative

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

object Notifier {
    const val CHANNEL = "new_mail"
    /** The intent extra that carries a tap's payload JSON. */
    const val EXTRA = "com.mailvault.notification"

    /** Posts every note of a run's reply `{channel, notes: [{id, title, body, accountId, folder, uid?}]}`. */
    fun post(context: Context, json: String) {
        val reply = try { JSONObject(json) } catch (e: Exception) { return }
        val notes = reply.optJSONArray("notes") ?: return
        if (notes.length() == 0) return
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            log(0, notes.length())
            return
        }
        ensureChannel(context, reply.optString("channel").ifEmpty { "New mail" })
        val manager = NotificationManagerCompat.from(context)
        var posted = 0
        for (i in 0 until notes.length()) {
            val note = notes.optJSONObject(i) ?: continue
            val id = note.optString("id")
            val payload = JSONObject()
                .put("accountId", note.optString("accountId"))
                .put("folder", note.optString("folder"))
            if (note.has("uid")) payload.put("uid", note.optLong("uid"))
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: continue
            launch.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            launch.putExtra(EXTRA, payload.toString())
            // One request code per message: PendingIntents that differ only in extras are one.
            val tap = PendingIntent.getActivity(
                context, id.hashCode(), launch,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            val notification = NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_email)
                .setContentTitle(note.optString("title"))
                .setContentText(note.optString("body"))
                .setCategory(NotificationCompat.CATEGORY_EMAIL)
                .setAutoCancel(true)
                .setContentIntent(tap)
                .build()
            try {
                manager.notify(id, 0, notification)
                posted += 1
            } catch (e: SecurityException) {
                break
            }
        }
        log(posted, notes.length() - posted)
    }

    /** Counts only (never a sender or subject), to logcat where the run scripts read them. */
    private fun log(posted: Int, refused: Int) {
        Log.i("MailVault", "MV_MOBILE {\"notifications\":{\"posted\":$posted,\"refused\":$refused}}")
    }

    private fun ensureChannel(context: Context, name: String) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        // Created once; a later call only renames it (the system keeps the user's choices).
        manager.createNotificationChannel(NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_DEFAULT))
    }

    /** Hands the tap in `intent`, if any, to the shell, once (the extra is removed). */
    fun takeTap(activity: Activity, intent: Intent?) {
        val payload = intent?.getStringExtra(EXTRA)
        Log.i("MailVault", "MV_MOBILE {\"notificationIntent\":{\"tap\":${payload != null}}}")
        if (payload == null) return
        intent.removeExtra(EXTRA)
        activity.intent?.removeExtra(EXTRA)
        nativeTapped(payload)
    }

    /** The shell's `Java_com_mailvault_mvnative_Notifier_nativeTapped`. */
    @JvmStatic
    private external fun nativeTapped(json: String)
}
