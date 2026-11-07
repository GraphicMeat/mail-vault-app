// MailVault mobile: the periodic background run on Android (plan Ruling 9). WorkManager runs it
// every 15 minutes at the earliest, with network, while notifications are on (unique work
// `mv-refresh`, queued KEEP by `MvNativePlugin.setBackgroundRefresh`). It runs in the app process,
// often with no activity (the app swiped away), so it loads the shell library itself; the shell
// fills what the activity would have (ndk-context, the TLS verifier) from this worker's
// application context (../../../../src/android.rs). The run uses the process's one engine and
// answers the notifications ready to post, which `Notifier` posts.

package com.mailvault.mvnative

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
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
            return Result.success()
        }
        Notifier.post(app, json)
        return Result.success()
    }

    /** One background run of the shell (`Java_com_mailvault_mvnative_BackgroundFetchWorker_nativeFetch`). */
    private external fun nativeFetch(dataDir: String, cacheDir: String, budgetMs: Int): String

    companion object {
        /** The unique periodic work. */
        const val NAME = "mv-refresh"
        const val BUDGET_MS = 25_000

        init {
            System.loadLibrary("mailvault_mobile_lib")
        }

        /** Queues the periodic run (kept if already queued) or cancels it. */
        fun schedule(context: Context, enabled: Boolean) {
            val work = WorkManager.getInstance(context.applicationContext)
            if (!enabled) {
                work.cancelUniqueWork(NAME)
                return
            }
            val request = PeriodicWorkRequestBuilder<BackgroundFetchWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            work.enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
