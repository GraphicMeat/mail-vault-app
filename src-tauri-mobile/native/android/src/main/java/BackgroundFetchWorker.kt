// MailVault mobile: the background run on Android (plan Ruling 9). WorkManager runs it every 15
// minutes at the earliest, with network, while the engine wants runs (notifications, background
// download, a scheduled send or a reminder: unique work `mv-refresh`, queued KEEP by
// `MvNativePlugin.setBackgroundRefresh`), and once soon after the app leaves the front (unique
// work `mv-catchup`, `MvNativePlugin.onStop`), so a sync cut by the app going away is finished
// and new mail is downloaded with the app out of sight. Each run fetches new headers and the
// bodies of recent INBOX mail (the engine bounds it by the budget), so the mail is there offline.
// When WorkManager stops the worker early (constraints lost, quota), `onStopped` tells the engine
// to stop its download before the next body; what it wrote stays for the next run. It runs in the app process,
// often with no activity (the app swiped away), so it loads the shell library itself; the shell
// fills what the activity would have (ndk-context, the TLS verifier) from this worker's
// application context (../../../../src/android.rs). The run uses the process's one engine and
// answers the notifications ready to post, which `Notifier` posts; then the run's commit token
// goes back to the shell, which counts that mail as notified (a run that dies before it returns
// the same mail next time; the ids are per message, so a repost replaces).

package com.mailvault.mvnative

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

class BackgroundFetchWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val app = applicationContext
        val json = try {
            nativeFetch(app.dataDir.absolutePath, app.cacheDir.absolutePath, BUDGET_MS)
        } catch (e: Throwable) {
            // The class only, never a message that could carry mail.
            Log.w("MailVault", "MV_MOBILE {\"backgroundError\":\"${e.javaClass.simpleName}\"}")
            return Result.success()
        }
        Notifier.post(app, json)
        val token = try { org.json.JSONObject(json).optString("commit") } catch (e: Exception) { "" }
        if (token.isNotEmpty()) {
            try {
                nativeCommit(token)
            } catch (e: Throwable) {
                Log.w("MailVault", "MV_MOBILE {\"backgroundCommitError\":\"${e.javaClass.simpleName}\"}")
            }
        }
        return Result.success()
    }

    override fun onStopped() {
        try {
            nativeStop()
        } catch (e: Throwable) {
            Log.w("MailVault", "MV_MOBILE {\"backgroundStopError\":\"${e.javaClass.simpleName}\"}")
        }
    }

    /** WorkManager stopped the worker: the engine's download stops (`Java_com_mailvault_mvnative_BackgroundFetchWorker_nativeStop`). */
    private external fun nativeStop()

    /** One background run of the shell (`Java_com_mailvault_mvnative_BackgroundFetchWorker_nativeFetch`). */
    private external fun nativeFetch(dataDir: String, cacheDir: String, budgetMs: Int): String

    /** The run's notifications were posted (`Java_com_mailvault_mvnative_BackgroundFetchWorker_nativeCommit`). */
    private external fun nativeCommit(token: String)

    companion object {
        /** The unique periodic work. */
        const val NAME = "mv-refresh"
        /** The one-off run after the app leaves the front. */
        const val CATCH_UP = "mv-catchup"
        const val BUDGET_MS = 25_000

        /** What `setBackgroundRefresh` last said: the engine wants background runs. */
        @Volatile var enabled = false

        init {
            System.loadLibrary("mailvault_mobile_lib")
        }

        /** Queues the periodic run (kept if already queued) or cancels it. */
        fun schedule(context: Context, enabled: Boolean) {
            this.enabled = enabled
            val work = WorkManager.getInstance(context.applicationContext)
            if (!enabled) {
                work.cancelUniqueWork(NAME)
                work.cancelUniqueWork(CATCH_UP)
                return
            }
            val request = PeriodicWorkRequestBuilder<BackgroundFetchWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            work.enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        /** The app left the front: one run soon, with network (kept if one is already queued). */
        fun catchUp(context: Context) {
            if (!enabled) return
            val request = OneTimeWorkRequestBuilder<BackgroundFetchWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(CATCH_UP, ExistingWorkPolicy.KEEP, request)
        }
    }
}
