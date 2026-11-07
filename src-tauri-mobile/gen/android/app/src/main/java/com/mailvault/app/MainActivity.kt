package com.mailvault.app

import android.content.res.Configuration
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

// Hand-edited, not the `tauri android init` template: re-running init loses this file
// (see architecture.md, Mobile). targetSdk 36 forces edge-to-edge, and env(safe-area-inset-*) is 0
// in the Android WebView, so the system bar and cutout insets are pushed to the page as the CSS
// variables --mv-inset-top/right/bottom/left (CSS px), which src/mobile/mobile.css reads.
class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var insetsScript: ScriptHandler? = null
  private var lastInsetsJs: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // A background run may have started this process without an activity and filled ndk-context
    // itself; the shell empties it again so tao's fill in super.onCreate does not abort the
    // process (src-tauri-mobile/src/android.rs).
    nativeBeforeActivity()
    try {
      super.onCreate(savedInstanceState)
    } finally {
      nativeAfterActivity()
    }
    applySystemBarAppearance(resources.configuration)
  }

  private external fun nativeBeforeActivity()
  private external fun nativeAfterActivity()

  companion object {
    init {
      System.loadLibrary("mailvault_mobile_lib")
    }
  }

  // The manifest's configChanges includes uiMode, so a theme switch lands here instead of
  // recreating the activity: the status and navigation bar icons have to follow by hand.
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    enableEdgeToEdge()
    applySystemBarAppearance(newConfig)
    webView?.setBackgroundColor(ContextCompat.getColor(this, R.color.mv_window_bg))
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    // Same colour as the page background, so no white frame shows before the first paint.
    webView.setBackgroundColor(ContextCompat.getColor(this, R.color.mv_window_bg))
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val density = view.resources.displayMetrics.density
      pushInsets(bars.top / density, bars.right / density, bars.bottom / density, bars.left / density)
      // Let the WebView handle the insets as it would without this listener, and pass them on
      // unconsumed.
      ViewCompat.onApplyWindowInsets(view, insets)
      insets
    }
    ViewCompat.requestApplyInsets(webView)
  }

  private fun applySystemBarAppearance(config: Configuration) {
    val night = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = !night
    controller.isAppearanceLightNavigationBars = !night
  }

  private fun pushInsets(top: Float, right: Float, bottom: Float, left: Float) {
    val js = "(function(){var v={top:$top,right:$right,bottom:$bottom,left:$left};" +
      "function a(){var r=document.documentElement;if(!r)return false;" +
      "for(var k in v)r.style.setProperty('--mv-inset-'+k,v[k]+'px');return true}" +
      "if(!a())document.addEventListener('DOMContentLoaded',a,{once:true})})();"
    if (js == lastInsetsJs) return
    lastInsetsJs = js
    val wv = webView ?: return
    // Insets can arrive before the document exists, and every navigation starts a new one: a
    // document-start script carries the latest values into each load, and evaluateJavascript
    // updates the page already showing.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      insetsScript?.remove()
      insetsScript = WebViewCompat.addDocumentStartJavaScript(wv, js, setOf("*"))
    }
    wv.evaluateJavascript(js, null)
  }
}
