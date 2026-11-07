// MailVault mobile: a tapped mail link out of the sandboxed frame on Android.
//
// The frame's links open in a new window (`<base target="_blank">`, sandbox `allow-popups`). With
// multiple windows off (the WebView default) Chromium would have to load such a link in the top
// window, which the sandbox forbids, so the tap did nothing. With multiple windows on, the popup
// asks `onCreateWindow` (a popup without a user gesture is refused). We hand it a bare, never-shown
// WebView (never a Tauri webview: no IPC, no JavaScript) that only catches the URL it was asked to
// load, cancels that load and is destroyed. The URL never goes near the app's own WebView: if
// `PopupUrlPolicy` accepts it (http(s) off this device, or mailto) it goes straight to the system
// as `ACTION_VIEW` + `CATEGORY_BROWSABLE`; anything else is dropped.
//
// Every other callback is passed to the WebChromeClient that was there before (wry's, final).

package com.mailvault.mvnative

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Message
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

class PopupChromeClient(private val activity: Activity, private val inner: WebChromeClient) : WebChromeClient() {
    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
        if (!isUserGesture) return false
        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        val catcher = WebView(view.context)
        var caught = false
        fun hand(url: String?) {
            // The catcher's own first page is about:blank; wait for the real one.
            if (caught || url.isNullOrEmpty() || url == "about:blank") return
            caught = true
            catcher.post { catcher.stopLoading(); catcher.destroy() }
            val accepted = PopupUrlPolicy.allow(url)
            Log.i("MailVault", "MV_MOBILE {\"nav\":{\"via\":\"popup\",\"verdict\":\"${if (accepted != null) "external" else "deny"}\"}}")
            if (accepted != null) openOutside(accepted)
        }
        catcher.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                hand(request.url.toString())
                return true
            }

            override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) {
                v.stopLoading()
                hand(url)
            }
        }
        transport.webView = catcher
        resultMsg.sendToTarget()
        return true
    }

    /** The system browser or mail app; never this app's WebView. */
    private fun openOutside(url: String) {
        val uri = Uri.parse(url)
        // Second gate on Android's own parse of the string the policy accepted.
        if (uri.scheme?.lowercase() !in setOf("http", "https", "mailto")) return
        val intent = Intent(Intent.ACTION_VIEW, uri)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        intent.selector = null
        intent.component = null
        try {
            activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            // No browser or mail app: nothing opens.
        }
    }

    override fun onCloseWindow(window: WebView) = inner.onCloseWindow(window)
    override fun onProgressChanged(view: WebView, newProgress: Int) = inner.onProgressChanged(view, newProgress)
    override fun onReceivedTitle(view: WebView, title: String?) = inner.onReceivedTitle(view, title)
    override fun onReceivedIcon(view: WebView, icon: Bitmap?) = inner.onReceivedIcon(view, icon)
    override fun onReceivedTouchIconUrl(view: WebView, url: String?, precomposed: Boolean) =
        inner.onReceivedTouchIconUrl(view, url, precomposed)
    override fun onShowCustomView(view: View, callback: CustomViewCallback) = inner.onShowCustomView(view, callback)
    override fun onHideCustomView() = inner.onHideCustomView()
    override fun onRequestFocus(view: WebView) = inner.onRequestFocus(view)
    override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean =
        inner.onJsAlert(view, url, message, result)
    override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean =
        inner.onJsConfirm(view, url, message, result)
    override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: JsPromptResult): Boolean =
        inner.onJsPrompt(view, url, message, defaultValue, result)
    override fun onJsBeforeUnload(view: WebView, url: String, message: String, result: JsResult): Boolean =
        inner.onJsBeforeUnload(view, url, message, result)
    override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
        inner.onGeolocationPermissionsShowPrompt(origin, callback)
    override fun onGeolocationPermissionsHidePrompt() = inner.onGeolocationPermissionsHidePrompt()
    override fun onPermissionRequest(request: PermissionRequest) = inner.onPermissionRequest(request)
    override fun onPermissionRequestCanceled(request: PermissionRequest) = inner.onPermissionRequestCanceled(request)
    override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean = inner.onConsoleMessage(consoleMessage)
    override fun getDefaultVideoPoster(): Bitmap? = inner.defaultVideoPoster
    override fun getVideoLoadingProgressView(): View? = inner.videoLoadingProgressView
    override fun getVisitedHistory(callback: ValueCallback<Array<String>>) = inner.getVisitedHistory(callback)
    override fun onShowFileChooser(
        webView: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
    ): Boolean = inner.onShowFileChooser(webView, filePathCallback, fileChooserParams)
}
