// MailVault mobile: the system viewer, share sheet and browser for the shell (see ../../../../src/lib.rs).
// Called only from Rust, never from JS. Files go out as content:// URIs of the app's FileProvider
// (authority <applicationId>.fileprovider, which exposes only <cache>/share/), with a read grant.

package com.mailvault.mvnative

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class FileArgs {
    lateinit var path: String
    var mime: String? = null
}

@InvokeArg
class UrlArgs {
    lateinit var url: String
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
}
