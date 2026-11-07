// MailVault mobile: a tapped mail link out of the sandboxed frame on Android.
//
// The frame's links open in a new window (`<base target="_blank">`, sandbox `allow-popups`). With
// multiple windows off (the WebView default) Chromium would have to load such a link in the top
// window, which the sandbox forbids, so the tap did nothing. With multiple windows on, the popup
// asks `onCreateWindow`: we hand it a bare, never-shown WebView (no Tauri IPC, no JavaScript)
// that only catches the URL it was asked to load and cancels that load, then ask the app's own
// WebView to load the URL. That load goes through the shell's navigation hook
// (`tauri-plugin-mv-native` links.rs): a web or mail link is cancelled there and handed to the
// system, anything else is just cancelled. A popup without a user gesture is refused.
//
// Every other callback is passed to the WebChromeClient that was there before (wry's, final).

package com.mailvault.mvnative

import android.graphics.Bitmap
import android.net.Uri
import android.os.Message
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

class PopupChromeClient(private val inner: WebChromeClient) : WebChromeClient() {
    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
        if (!isUserGesture) return false
        val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
        val catcher = WebView(view.context)
        var caught = false
        fun hand(url: String?) {
            if (caught || url.isNullOrEmpty() || url == "about:blank") return
            caught = true
            // The app's WebView decides: RustWebView.loadUrl asks the shell's navigation hook first.
            view.post { view.loadUrl(url) }
            catcher.post { catcher.stopLoading(); catcher.destroy() }
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
