package com.mailvault.mvnative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PopupUrlPolicyTest {
    @Test
    fun web_and_mail_links_are_allowed() {
        assertEquals("https://example.com/garden?a=b#c", PopupUrlPolicy.allow("https://example.com/garden?a=b#c"))
        assertNotNull(PopupUrlPolicy.allow("http://example.com/"))
        assertNotNull(PopupUrlPolicy.allow("HTTPS://Example.COM/"))
        assertEquals("mailto:ada@example.test?subject=Hi", PopupUrlPolicy.allow("mailto:ada@example.test?subject=Hi"))
    }

    @Test
    fun other_schemes_are_dropped() {
        for (url in listOf(
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,<b>x</b>",
            "file:///data/data/com.mailvault.app/databases/mobile.db",
            "intent://scan/#Intent;scheme=zxing;package=com.evil;end",
            "intent:#Intent;component=com.mailvault.app/.MainActivity;end",
            "content://com.mailvault.app.fileprovider/share/x",
            "about:blank",
            "about:srcdoc",
            "tauri://localhost/mobile.html",
            "blob:https://example.com/0f0e",
            "tel:+15550100",
            "mailto:",
            "",
        )) {
            assertNull(url, PopupUrlPolicy.allow(url))
        }
        assertNull(PopupUrlPolicy.allow(null))
    }

    @Test
    fun this_device_is_not_a_web_host() {
        for (url in listOf(
            "http://tauri.localhost/",
            "https://tauri.localhost/mobile.html?ui=viewer",
            "https://localhost/",
            "http://LOCALHOST:8080/",
            "http://ipc.localhost/plugin",
            "http://127.0.0.1/",
            "http://[::1]/",
            "http://0.0.0.0/",
            "https:///nohost",
        )) {
            assertNull(url, PopupUrlPolicy.allow(url))
        }
    }

    @Test
    fun user_info_and_long_urls_are_dropped() {
        assertNull(PopupUrlPolicy.allow("https://user:pass@example.com/"))
        assertNull(PopupUrlPolicy.allow("https://example.com/" + "a".repeat(PopupUrlPolicy.MAX_URL_LEN)))
        assertNotNull(PopupUrlPolicy.allow("https://example.com/" + "a".repeat(1000)))
    }

    @Test
    fun unparseable_urls_are_dropped() {
        assertNull(PopupUrlPolicy.allow("https://exa mple.com/"))
        assertNull(PopupUrlPolicy.allow("ht!tp://example.com/"))
    }
}
