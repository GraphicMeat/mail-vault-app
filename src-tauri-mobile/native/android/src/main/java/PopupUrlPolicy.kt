// MailVault mobile: which URL a mail-frame popup may hand to the system (PopupChromeClient.kt).
// Pure Kotlin on java.net.URI, so it runs in a plain JVM unit test (android.net.Uri does not).
// The shell's Rust filter (tauri-plugin-mv-native links.rs) is the same rule for the navigations
// it sees; this one guards the popup path, which never touches the app's WebView.

package com.mailvault.mvnative

import java.net.URI

object PopupUrlPolicy {
    /** Longer URLs are refused outright, as in links.rs. */
    const val MAX_URL_LEN = 32 * 1024

    private val LOCAL_HOSTS = setOf("tauri.localhost", "localhost", "0.0.0.0", "[::1]", "::1", "[::]", "::")

    /** 127.0.0.0/8 and the IPv4-mapped loopback, as literals (no DNS lookup). */
    private fun isLoopbackLiteral(host: String): Boolean {
        val h = host.removePrefix("[").removeSuffix("]")
        if (Regex("""^127(\.\d{1,3}){3}$""").matches(h)) return true
        if (h.startsWith("::ffff:127.") || h == "::ffff:0.0.0.0" || h == "0:0:0:0:0:0:0:1" || h == "0:0:0:0:0:0:0:0") return true
        return false
    }

    /** A query key `attach` or `attachment` (any case) in a mailto: some mail apps attach that file. */
    private fun asksToAttach(ssp: String): Boolean {
        val query = ssp.substringAfter('?', "")
        return query.split('&').any { pair ->
            val key = pair.substringBefore('=').lowercase()
            key == "attach" || key == "attachment"
        }
    }

    /**
     * The URL to hand to the system, normalised, or null to drop it: only `mailto:`, and `http(s)`
     * with a host that is not this device (no `localhost`, no `*.localhost`, no loopback) and no
     * user info. Everything else (`javascript:`, `data:`, `file:`, `intent:`, `about:`, ...) is null.
     */
    fun allow(url: String?): String? {
        if (url.isNullOrEmpty() || url.length > MAX_URL_LEN) return null
        val uri = try { URI(url) } catch (e: Exception) { return null }
        return when (uri.scheme?.lowercase()) {
            "mailto" -> when {
                !uri.isOpaque || uri.rawSchemeSpecificPart.isNullOrEmpty() -> null
                asksToAttach(uri.rawSchemeSpecificPart) -> null
                else -> uri.toASCIIString()
            }
            "http", "https" -> {
                val host = uri.host?.lowercase()?.trimEnd('.')
                when {
                    host.isNullOrEmpty() -> null
                    host in LOCAL_HOSTS || host.endsWith(".localhost") -> null
                    isLoopbackLiteral(host) -> null
                    uri.rawUserInfo != null -> null
                    else -> uri.toASCIIString()
                }
            }
            else -> null
        }
    }
}
