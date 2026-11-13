// MailVault mobile: the system viewer, share sheet and browser for the shell (see ../../../../src/lib.rs).
// Called only from Rust, never from JS. Files go out as content:// URIs of the app's FileProvider
// (authority <applicationId>.fileprovider, which exposes only <cache>/share/), with a read grant.
// `pickFiles` runs the system document or photo picker and copies each pick into the directory
// Rust named; Rust names and moves the copies (see ../../../../src/files.rs `finish_pick`).
// `openAuth` shows a provider's sign-in page in a Custom Tab and answers when the tab goes away:
// the user closed it (`{cancelled: true}`) or `closeAuth` brought MainActivity back over it
// (`{cancelled: false}`).
// `setBackgroundRefresh` queues or cancels the periodic background run (BackgroundFetchWorker.kt),
// `requestNotifications` asks for POST_NOTIFICATIONS on Android 13 and later, and a notification
// tap that started or resumed MainActivity is handed to the shell (Notifier.kt).
// `storeProducts`, `storePurchase` and `storeRestore` are Google Play (Store.kt), whose
// unaccepted purchases are handed over again when the plugin loads.

package com.mailvault.mvnative

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import androidx.browser.customtabs.CustomTabsIntent
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.PermissionState
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.PluginManager
import java.io.File
import java.io.FileOutputStream

@InvokeArg
class FileArgs {
    lateinit var path: String
    var mime: String? = null
}

@InvokeArg
class UrlArgs {
    lateinit var url: String
}

@InvokeArg
class RefreshArgs {
    var enabled: Boolean = false
}

@InvokeArg
class CloseArgs {
    var url: String? = null
}

@InvokeArg
class PermissionArgs {
    var prompt: Boolean = true
}

@InvokeArg
class PurchaseArgs {
    lateinit var productId: String
}

@InvokeArg
class PickArgs {
    lateinit var kind: String
    lateinit var dir: String
}

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class MvNativePlugin(private val activity: Activity) : Plugin(activity) {
    // Mail links leave the frame in a new window: catch it (PopupChromeClient.kt). A notification
    // tap that started the app is handed over now (the shell holds it until the page takes it).
    override fun load(webView: WebView) {
        val inner = webView.webChromeClient ?: WebChromeClient()
        webView.settings.setSupportMultipleWindows(true)
        webView.webChromeClient = PopupChromeClient(activity, inner)
        Notifier.takeTap(activity, activity.intent)
        store.start()
    }

    // Google Play (Store.kt): one billing client for the plugin's life.
    private val store by lazy { StoreBilling(activity) }

    @Command
    fun storeProducts(invoke: Invoke) {
        store.products(invoke)
    }

    @Command
    fun storePurchase(invoke: Invoke) {
        val args = try { invoke.parseArgs(PurchaseArgs::class.java) } catch (e: Exception) {
            invoke.reject("bad arguments", "INVALID")
            return
        }
        store.purchase(invoke, args.productId)
    }

    @Command
    fun storeRestore(invoke: Invoke) {
        store.restore(invoke)
    }

    // MainActivity is singleTask: a tap while it exists arrives here.
    override fun onNewIntent(intent: Intent) {
        Notifier.takeTap(activity, intent)
    }

    @Command
    fun setBackgroundRefresh(invoke: Invoke) {
        val args = invoke.parseArgs(RefreshArgs::class.java)
        try {
            BackgroundFetchWorker.schedule(activity, args.enabled)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.javaClass.simpleName, "INTERNAL")
        }
    }

    // `requestNotifications {prompt}`: the permission prompt (Android 13 and later) when not yet
    // granted, else the current answer; `prompt: false` only reads it (Settings checks each time).
    @Command
    fun requestNotifications(invoke: Invoke) {
        val prompt = try { invoke.parseArgs(PermissionArgs::class.java).prompt } catch (e: Exception) { true }
        if (!prompt || Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            answerNotifications(invoke)
        } else {
            requestPermissionForAlias("notifications", invoke, "notificationsAnswered")
        }
    }

    @PermissionCallback
    fun notificationsAnswered(invoke: Invoke) {
        answerNotifications(invoke)
    }

    private fun answerNotifications(invoke: Invoke) {
        val granted = NotificationManagerCompat.from(activity).areNotificationsEnabled()
        invoke.resolve(JSObject().put("granted", granted))
    }
    private fun contentUri(path: String): Uri {
        return FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", File(path))
    }

    private fun start(invoke: Invoke, intent: Intent) {
        try {
            activity.startActivity(intent)
            invoke.resolve()
        } catch (e: ActivityNotFoundException) {
            invoke.reject("no app on this device handles this", "NO_APP")
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.javaClass.simpleName, "INTERNAL")
        }
    }

    @Command
    fun openFile(invoke: Invoke) {
        val args = invoke.parseArgs(FileArgs::class.java)
        val uri = try { contentUri(args.path) } catch (e: Exception) {
            invoke.reject("not a shareable file", "INTERNAL")
            return
        }
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, args.mime ?: "application/octet-stream")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        start(invoke, intent)
    }

    @Command
    fun shareFile(invoke: Invoke) {
        val args = invoke.parseArgs(FileArgs::class.java)
        val uri = try { contentUri(args.path) } catch (e: Exception) {
            invoke.reject("not a shareable file", "INTERNAL")
            return
        }
        val send = Intent(Intent.ACTION_SEND)
            .setType(args.mime ?: "application/octet-stream")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        // The grant travels with ClipData through the chooser to the chosen app.
        send.clipData = ClipData.newRawUri("", uri)
        val chooser = Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        start(invoke, chooser)
    }

    @Command
    fun openUrl(invoke: Invoke) {
        val args = invoke.parseArgs(UrlArgs::class.java)
        val uri = Uri.parse(args.url)
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https" && scheme != "mailto") {
            invoke.reject("not an http, https or mailto URL", "INTERNAL")
            return
        }
        // BROWSABLE: only an app that declares it may be opened from a link takes it. No component,
        // no selector: the system picks the browser or mail app.
        val intent = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
        start(invoke, intent)
    }

    // The running sign-in tab. Custom Tabs report nothing back, so the tab's end is read from the
    // activity's lifecycle: launching it pauses MainActivity (`authAway`), and MainActivity resuming
    // after that means the tab is gone, closed by the user unless `closeAuth` asked first
    // (`authClosing`). Main thread only, like the lifecycle callbacks.
    private var authInvoke: Invoke? = null
    private var authAway = false
    private var authClosing = false
    private var authActivity: Activity? = null
    // The URL of the running tab; one `closeAuth` named before its tab's open arrived (that open
    // answers at once and shows nothing); and a close answered while the tab was still starting,
    // so the tab is taken off as soon as it covers the app.
    private var authUrl: String? = null
    private var closedBeforeOpen: String? = null
    private var closeOnPauseUntil = 0L

    private fun answerAuth(cancelled: Boolean) {
        val invoke = authInvoke ?: return
        authInvoke = null
        authUrl = null
        authAway = false
        authClosing = false
        authActivity = null
        invoke.resolve(JSObject().put("cancelled", cancelled))
    }

    @Command
    fun openAuth(invoke: Invoke) {
        val args = invoke.parseArgs(UrlArgs::class.java)
        if (!PopupUrlPolicy.authUrlOk(args.url)) {
            invoke.reject("not a sign-in page", "INTERNAL")
            return
        }
        activity.runOnUiThread {
            if (closedBeforeOpen != null && closedBeforeOpen == args.url) {
                closedBeforeOpen = null
                invoke.resolve(JSObject().put("cancelled", false))
                return@runOnUiThread
            }
            if (authInvoke != null) {
                invoke.reject("a sign-in sheet is already open", "BUSY")
                return@runOnUiThread
            }
            authInvoke = invoke
            authUrl = args.url
            authAway = false
            authClosing = false
            authActivity = PluginManager.activity
            try {
                // In this task (no NEW_TASK), so `closeAuth`'s CLEAR_TOP takes the tab off the top.
                CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, Uri.parse(args.url))
            } catch (e: ActivityNotFoundException) {
                authInvoke = null
                authActivity = null
                invoke.reject("no browser on this device", "NO_APP")
            } catch (e: Exception) {
                authInvoke = null
                authActivity = null
                invoke.reject(e.message ?: e.javaClass.simpleName, "INTERNAL")
            }
        }
    }

    // Brings MainActivity back to the front, which finishes the tab above it; its `openAuth` then
    // answers from `onResume`. Answers at once; nothing to close is not an error.
    @Command
    fun closeAuth(invoke: Invoke) {
        val url = try { invoke.parseArgs(CloseArgs::class.java).url } catch (e: Exception) { null }
        activity.runOnUiThread {
            if (authInvoke == null || (url != null && url != authUrl)) {
                // Its open has not arrived yet: that open shows nothing.
                if (url != null) closedBeforeOpen = url
            } else {
                authClosing = true
                if (authAway) {
                    try {
                        val front = Intent(activity, activity.javaClass)
                            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        activity.startActivity(front)
                    } catch (e: Exception) {
                        // Still answered: the page goes on, the tab stays until the user closes it.
                        answerAuth(false)
                    }
                } else {
                    // The tab never covered the app (it failed to show, or is still starting): if
                    // it covers it in a moment, it is taken off again.
                    answerAuth(false)
                    closeOnPauseUntil = System.currentTimeMillis() + 5_000
                }
            }
            invoke.resolve()
        }
    }

    override fun onPause(activity: AppCompatActivity) {
        if (authInvoke != null) authAway = true
        if (closeOnPauseUntil > System.currentTimeMillis()) {
            closeOnPauseUntil = 0L
            try {
                val front = Intent(activity, activity.javaClass)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                activity.startActivity(front)
            } catch (e: Exception) {
                // The tab stays until the user closes it; the page went on long ago.
            }
        }
    }

    // The app is out of sight: a run soon finishes the sync it was in and downloads new mail
    // (`BackgroundFetchWorker.catchUp`; nothing when the engine wants no background runs).
    override fun onStop(activity: AppCompatActivity) {
        try {
            BackgroundFetchWorker.catchUp(activity)
        } catch (e: Exception) {
            // The periodic run still comes.
        }
    }

    override fun onResume(activity: AppCompatActivity) {
        if (authInvoke != null && authAway) answerAuth(!authClosing)
    }

    // Where the picks of the running pick go; set before the picker starts, read in its callback.
    // The shell lets one pick run at a time (`PickGuard`), so one field is enough.
    @Volatile private var pickDir: File? = null
    // The running pick's invoke and the activity it was launched from. The activity result is
    // lost if that activity is destroyed for good (not a configuration change, where the result
    // registry hands the result to the recreated activity): then nothing would ever answer, so
    // `onDestroy` rejects the invoke and the shell's waiting thread returns.
    private var pendingPick: Invoke? = null
    private var pickActivity: Activity? = null
    private val pickLock = Any()

    // The pending pick if it is `invoke` (or any, for null), now no longer pending. Each pick is
    // answered exactly once: by its result, by `onDestroy`, or by a newer pick taking over.
    private fun takePending(invoke: Invoke?): Invoke? = synchronized(pickLock) {
        val pending = pendingPick
        if (pending == null || (invoke != null && pending !== invoke)) return null
        pendingPick = null
        pickActivity = null
        pending
    }

    override fun onDestroy(activity: AppCompatActivity) {
        // The sheet's activity gone for good: answer as a cancel, so the page cancels the flow.
        if (authInvoke != null && authActivity === activity && !activity.isChangingConfigurations) {
            answerAuth(true)
        }
        val lost = synchronized(pickLock) {
            pickActivity === activity && !activity.isChangingConfigurations
        }
        if (lost) takePending(null)?.reject("the picker's screen went away", "INTERNAL")
    }

    @Command
    fun pickFiles(invoke: Invoke) {
        val args = invoke.parseArgs(PickArgs::class.java)
        val dir = File(args.dir)
        if (!dir.isAbsolute || !dir.isDirectory) {
            invoke.reject("bad pick directory", "INTERNAL")
            return
        }
        val intent = when {
            args.kind == "photos" && Build.VERSION.SDK_INT >= 33 ->
                // The system photo picker: no storage permission, several at once.
                Intent(MediaStore.ACTION_PICK_IMAGES)
                    .setType("image/*")
                    .putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit())
            args.kind == "photos" ->
                Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("image/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            args.kind == "files" ->
                Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            else -> {
                invoke.reject("unknown picker", "INTERNAL")
                return
            }
        }
        // The shell only lets a new pick in while one is pending when that one was given up as
        // lost: answer it now, so its waiting thread returns.
        takePending(null)?.reject("a newer pick took over", "BUSY")
        pickDir = dir
        synchronized(pickLock) {
            pendingPick = invoke
            pickActivity = PluginManager.activity
        }
        try {
            startActivityForResult(invoke, intent, "pickResult")
        } catch (e: ActivityNotFoundException) {
            takePending(invoke)?.reject("no picker on this device", "NO_APP")
        } catch (e: Exception) {
            takePending(invoke)?.reject(e.message ?: e.javaClass.simpleName, "INTERNAL")
        }
    }

    // On the main thread: the copies run on a worker, then answer. Cancel is an empty list.
    @ActivityCallback
    fun pickResult(invoke: Invoke, result: ActivityResult) {
        // Already answered (its activity went away, or a newer pick took over): nothing to do.
        if (takePending(invoke) == null) return
        val dir = pickDir
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            invoke.resolve(JSObject().put("items", JSArray()))
            return
        }
        // Picks made but nowhere to put them: an error, never something that looks like a cancel.
        if (dir == null) {
            invoke.reject("the pick directory is gone", "INTERNAL")
            return
        }
        val uris = mutableListOf<Uri>()
        val clip = data.clipData
        if (clip != null) {
            for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) }
        } else {
            data.data?.let { uris.add(it) }
        }
        Thread {
            // Any throw still answers, so the shell's waiting thread never hangs.
            try {
                val items = JSArray()
                uris.forEachIndexed { i, uri -> items.put(copyPick(uri, File(dir, i.toString()))) }
                invoke.resolve(JSObject().put("items", items))
            } catch (e: Throwable) {
                invoke.reject(e.message ?: e.javaClass.simpleName, "INTERNAL")
            }
        }.start()
    }

    // One pick into `target`: `{file, name, mime}`, or `{name, error: "UNREADABLE"}` when the
    // provider cannot hand over every byte (a cloud file not downloaded, a provider error).
    private fun copyPick(uri: Uri, target: File): JSObject {
        val resolver = activity.contentResolver
        var name = ""
        var size = -1L
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val s = c.getColumnIndex(OpenableColumns.SIZE)
                    if (n >= 0 && !c.isNull(n)) name = c.getString(n) ?: ""
                    if (s >= 0 && !c.isNull(s)) size = c.getLong(s)
                }
            }
        } catch (e: Exception) {
            // No metadata: the name falls back to the URI's last segment below.
        }
        if (name.isEmpty()) name = uri.lastPathSegment?.substringAfterLast('/') ?: ""
        val mime = try { resolver.getType(uri) } catch (e: Exception) { null } ?: "application/octet-stream"
        val copied = try {
            val input = resolver.openInputStream(uri) ?: throw java.io.IOException("no stream")
            input.use { inp -> FileOutputStream(target).use { out -> inp.copyTo(out) } }
        } catch (e: Exception) {
            -1L
        }
        if (copied < 0 || (size >= 0 && copied != size)) {
            target.delete()
            return JSObject().put("name", name).put("error", "UNREADABLE")
        }
        return JSObject().put("file", target.name).put("name", name).put("mime", mime)
    }
}
