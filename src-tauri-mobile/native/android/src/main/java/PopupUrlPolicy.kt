// MailVault mobile: which URL a mail-frame popup may hand to the system (PopupChromeClient.kt).
// Pure Kotlin on java.net, so it runs in a plain JVM unit test (android.net.Uri does not).
// The same rule as the shell's Rust filter (tauri-plugin-mv-native links.rs) for the navigations
// it sees, with the same test rows; this one guards the popup path, which never touches the app's
// WebView. java.net.URI does not normalise hosts as browsers do, so numeric hosts are decoded
// here the WHATWG way before they are judged.

package com.mailvault.mvnative

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI

object PopupUrlPolicy {
    /** Longer URLs are refused outright, as in links.rs. */
    const val MAX_URL_LEN = 32 * 1024

    /** The mailto keys that may reach a mail app; any other key (attach, x-...) drops the link. */
    private val MAILTO_KEYS = setOf("to", "cc", "bcc", "subject", "body")

    private val NUMBER = Regex("""^(0x[0-9a-f]*|[0-9]+)$""")
    private val NUMERIC_HOST = Regex("""^(0x[0-9a-f]*|[0-9]+)(\.(0x[0-9a-f]*|[0-9]+)){0,3}$""")

    /**
     * The URL to hand to the system, normalised, or null to drop it: only `mailto:` with nothing but
     * to/cc/bcc/subject/body keys, and `http(s)` with a host that is not this device (no
     * `localhost`, no `*.localhost`, no loopback or unspecified address in any spelling) and no user
     * info. Everything else (`javascript:`, `data:`, `file:`, `intent:`, `about:`, ...) is null.
     */
    fun allow(url: String?): String? {
        if (url.isNullOrEmpty() || url.length > MAX_URL_LEN) return null
        val uri = try { URI(url) } catch (e: Exception) { return null }
        return when (uri.scheme?.lowercase()) {
            "mailto" -> when {
                !uri.isOpaque || uri.rawSchemeSpecificPart.isNullOrEmpty() -> null
                uri.rawFragment != null -> null
                else -> canonicalMailto(uri.rawSchemeSpecificPart)
            }
            "http", "https" -> when {
                uri.rawUserInfo != null -> null
                !webHostOk(uri.host) -> null
                else -> uri.toASCIIString()
            }
            else -> null
        }
    }

    /** A host that is a machine other than this device. */
    private fun webHostOk(raw: String?): Boolean {
        val host = raw?.lowercase()?.removePrefix("[")?.removeSuffix("]")?.trimEnd('.') ?: return false
        if (host.isEmpty()) return false
        if (host == "localhost" || host.endsWith(".localhost")) return false
        if (':' in host) return ipv6Ok(host)
        if (NUMERIC_HOST.matches(host)) {
            val v4 = decodeIpv4(host) ?: return false
            return v4ok(v4)
        }
        // WHATWG reads a host whose last label is a number as IPv4; anything that is not a valid
        // one is no host a browser would go to.
        if (NUMBER.matches(host.substringAfterLast('.'))) return false
        return true
    }

    /** An IPv6 literal (contains ':', so InetAddress parses it and never asks DNS). */
    private fun ipv6Ok(host: String): Boolean {
        val addr = try { InetAddress.getByName(host) } catch (e: Exception) { return false }
        if (addr.isLoopbackAddress || addr.isAnyLocalAddress) return false
        val b = addr.address
        val v4 = when {
            addr is Inet4Address -> b // Java turns ::ffff:a.b.c.d into an Inet4Address.
            addr is Inet6Address && b.size == 16 && (0 until 10).all { b[it].toInt() == 0 } &&
                ((b[10].toInt() and 0xff) == 0xff && (b[11].toInt() and 0xff) == 0xff ||
                    b[10].toInt() == 0 && b[11].toInt() == 0) -> b.copyOfRange(12, 16)
            else -> null
        }
        return v4 == null || v4ok(v4.map { it.toLong() and 0xff })
    }

    private fun v4ok(octets: List<Long>): Boolean {
        if (octets[0] == 127L) return false
        if (octets.all { it == 0L }) return false
        return true
    }

    /** WHATWG IPv4 parsing: 1 to 4 parts, each decimal, octal (leading 0) or hex (0x); the last part
     *  fills the bytes that remain. Null when it is not a valid address. */
    internal fun decodeIpv4(host: String): List<Long>? {
        val parts = host.split('.')
        if (parts.isEmpty() || parts.size > 4) return null
        val nums = parts.map { p ->
            val n = when {
                p.startsWith("0x") -> if (p.length == 2) 0L else p.substring(2).toLongOrNull(16)
                p.length > 1 && p.startsWith("0") -> p.substring(1).toLongOrNull(8)
                else -> p.toLongOrNull(10)
            } ?: return null
            n
        }
        if (nums.dropLast(1).any { it > 255 }) return null
        val lastBytes = 5 - nums.size
        if (nums.last() >= (1L shl (8 * lastBytes))) return null
        var value = nums.last()
        nums.dropLast(1).forEachIndexed { i, n -> value += n shl (8 * (3 - i)) }
        return listOf((value shr 24) and 0xff, (value shr 16) and 0xff, (value shr 8) and 0xff, value and 0xff)
    }

    /**
     * A mailto rebuilt from checked parts, or null to deny it. The original string is never handed
     * on: a mail app may parse what this filter did not (a fragment, a value decoded twice).
     * Denied: a key (percent-decoded once, NULs dropped, trimmed, any case) that is not in
     * MAILTO_KEYS; a decoded value that still holds a `%XX` escape (double encoding); NUL, or CR/LF
     * outside `body`; an address path that decodes to something holding `?`, `#`, `&`, NUL or CR/LF.
     * Rebuilt: `mailto:` + the address path + `?` + `key=value` pairs with lowercase keys, every
     * value decoded once and re-encoded strictly (only unreserved characters stay, plus `@` and `,`
     * in the address fields). The same rule, byte for byte, as links.rs `canonical_mailto`.
     */
    private fun canonicalMailto(ssp: String): String? {
        val path = percentDecode(ssp.substringBefore('?')) ?: return null
        if (path.any { it in "?#&\u0000\r\n" } || hasPercentEscape(path)) return null
        val out = StringBuilder("mailto:").append(percentEncode(path, true))
        var sep = '?'
        for (pair in ssp.substringAfter('?', "").split('&')) {
            if (pair.isEmpty()) continue
            val key = percentDecode(pair.substringBefore('=')) ?: return null
            val k = key.replace("\u0000", "").trim().lowercase()
            if (k !in MAILTO_KEYS) return null
            val value = percentDecode(pair.substringAfter('=', "")) ?: return null
            val address = k != "subject" && k != "body"
            if (hasPercentEscape(value) || '\u0000' in value) return null
            if (k != "body" && ('\r' in value || '\n' in value)) return null
            out.append(sep).append(k).append('=').append(percentEncode(value, address))
            sep = '&'
        }
        return out.toString()
    }

    /** A `%` followed by two hex digits: the value was encoded twice. */
    private fun hasPercentEscape(s: String): Boolean =
        Regex("%[0-9A-Fa-f]{2}").containsMatchIn(s)

    /** Everything but unreserved characters (and `@`, `,` when [address]) as uppercase `%XX` UTF-8. */
    private fun percentEncode(s: String, address: Boolean): String {
        val out = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = (b.toInt() and 0xff).toChar()
            if (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c in "-._~" || (address && c in "@,")) {
                out.append(c)
            } else {
                out.append('%').append("%02X".format(b.toInt() and 0xff))
            }
        }
        return out.toString()
    }

    /** `%XX` decoding only (a `+` stays a `+`); null on a broken escape or bytes that are not UTF-8. */
    private fun percentDecode(s: String): String? {
        val out = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%') {
                if (i + 2 >= s.length) return null
                val hex = s.substring(i + 1, i + 3)
                if (!hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
                val v = hex.toInt(16)
                out.write(v)
                i += 3
            } else {
                out.write(c.toString().toByteArray(Charsets.UTF_8))
                i += 1
            }
        }
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(out.toByteArray())).toString()
        } catch (e: java.nio.charset.CharacterCodingException) {
            null
        }
    }
}
