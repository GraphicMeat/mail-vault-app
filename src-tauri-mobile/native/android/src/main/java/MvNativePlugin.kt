// MailVault mobile: the system viewer, share sheet and browser for the shell (see ../../../../src/lib.rs).
// Called only from Rust, never from JS. Files go out as content:// URIs of the app's FileProvider
// (authority <applicationId>.fileprovider, which exposes only <cache>/share/), with a read grant.
// `pickFiles` runs the system document or photo picker and copies each pick into the directory
// Rust named; Rust names and moves the copies (see ../../../../src/files.rs `finish_pick`).

package com.mailvault.mvnative

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
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
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
class PickArgs {
    lateinit var kind: String
    lateinit var dir: String
}

@TauriPlugin
class MvNativePlugin(private val activity: Activity) : Plugin(activity) {
    // Mail links leave the frame in a new window: catch it (PopupChromeClient.kt).
    override fun load(webView: WebView) {
        val inner = webView.webChromeClient ?: WebChromeClient()
        webView.settings.setSupportMultipleWindows(true)
        webView.webChromeClient = PopupChromeClient(activity, inner)
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

    // Where the picks of the running pick go; set before the picker starts, read in its callback.
    // One picker covers the screen at a time, so one field is enough.
    @Volatile private var pickDir: File? = null

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
        pickDir = dir
        try {
            startActivityForResult(invoke, intent, "pickResult")
        } catch (e: ActivityNotFoundException) {
            invoke.reject("no picker on this device", "NO_APP")
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.javaClass.simpleName, "INTERNAL")
        }
    }

    // On the main thread: the copies run on a worker, then answer. Cancel is an empty list.
    @ActivityCallback
    fun pickResult(invoke: Invoke, result: ActivityResult) {
        val dir = pickDir
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null || dir == null) {
            invoke.resolve(JSObject().put("items", JSArray()))
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
            val items = JSArray()
            uris.forEachIndexed { i, uri -> items.put(copyPick(uri, File(dir, i.toString()))) }
            invoke.resolve(JSObject().put("items", items))
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
