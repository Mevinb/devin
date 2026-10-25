package dev.pixelsentinel.shell

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/** A debuggable WebView host for the scanner, without browser-specific UI. */
class MainActivity : Activity() {
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // The shell deliberately has no native toolbar. System/IME insets resize the WebView.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            isFocusable = true
            isFocusableInTouchMode = true
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    if (intent.getBooleanExtra("dpad", false)) {
                        val script = assets.open("dpad.js").bufferedReader().use { it.readText() }
                        view.evaluateJavascript(script, null)
                    }
                }

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    // Do not hand tel:, intent:, file: or custom links to other Android apps.
                    return !isWebUrl(request.url)
                }
            }
        }
        setContentView(webView)
        hideStatusBar()
        webView.requestFocus()
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) loadIntent(intent)
    }

    @Suppress("DEPRECATION")
    private fun hideStatusBar() {
        if (Build.VERSION.SDK_INT >= 30) window.insetsController?.hide(WindowInsets.Type.statusBars())
        else window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        loadIntent(intent)
    }

    private fun isWebUrl(url: Uri): Boolean =
        url.scheme?.lowercase() in setOf("http", "https") || url.toString() == "about:blank"

    private fun loadIntent(intent: Intent) {
        val url = Uri.parse(intent.getStringExtra("url") ?: intent.dataString ?: "about:blank")
        webView.loadUrl(if (isWebUrl(url)) url.toString() else "about:blank")
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Platform callback retained for API 26+ shell navigation")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        webView.stopLoading()
        webView.destroy()
        super.onDestroy()
    }
}
