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
    fun mailto_with_an_attachment_is_dropped() {
        for (url in listOf(
            "mailto:ada@example.test?attach=/etc/passwd",
            "mailto:ada@example.test?subject=Hi&ATTACHMENT=file:///x",
            "mailto:ada@example.test?Attach=x",
            "mailto:?to=ada@example.test&attach=a",
        )) {
            assertNull(url, PopupUrlPolicy.allow(url))
        }
        assertNotNull(PopupUrlPolicy.allow("mailto:ada@example.test?subject=attach%20this&body=attachment"))
    }

    @Test
    fun loopback_spellings_are_dropped() {
        for (url in listOf("http://127.1.2.3/", "http://[::]/", "http://foo.localhost/")) {
            assertNull(url, PopupUrlPolicy.allow(url))
        }
    }

    // The same rows as links.rs `this_device_is_not_a_web_host` / `mailto_keeps_only_the_safe_keys`.
    @Test
    fun numeric_loopback_spellings_are_dropped() {
        for (url in listOf(
            "http://2130706433/",
            "http://0x7f.1/",
            "http://127.1/",
            "http://0177.0.0.1/",
            "http://017700000001/",
            "http://[::ffff:7f00:1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[0:0:0:0:0:ffff:127.0.0.1]/",
            "http://[0:0::1]/",
            "http://[::]/",
            "http://0/",
            "http://0.0.0.0/",
            "http://foo.123/",
            "http://foo.0x1f/",
        )) {
            assertNull(url, PopupUrlPolicy.allow(url))
        }
    }

    @Test
    fun ordinary_hosts_still_pass() {
        for (url in listOf("http://8.8.8.8/", "https://example.com/", "https://1.2.3.4.example.com/", "https://[2001:db8::1]/")) {
            assertNotNull(url, PopupUrlPolicy.allow(url))
        }
    }

    @Test
    fun mailto_keeps_only_the_safe_keys() {
        for (url in listOf(
            "mailto:a@b.test?att%61ch=/x",
            "mailto:a@b.test?%41TTACH=/x",
            "mailto:a@b.test?x-foo=1",
            "mailto:a@b.test?subject=Hi&in-reply-to=x",
            "mailto:a@b.test?%00attach=/x",
        )) {
            assertNull(url, PopupUrlPolicy.allow(url))
        }
        for (url in listOf(
            "mailto:a@b.test",
            "mailto:a@b.test?to=c@d.test&cc=e@f.test&bcc=g@h.test&subject=Hi&body=Hello",
            "mailto:a@b.test?SUBJECT=Hi&Body=x",
            "mailto:?to=a@b.test",
        )) {
            assertNotNull(url, PopupUrlPolicy.allow(url))
        }
    }

    // The same rows as links.rs `mailto_is_rebuilt_from_checked_pairs`.
    @Test
    fun mailto_is_rebuilt_from_checked_pairs() {
        for (url in listOf(
            "mailto:a@b.test?subject=x#&attach=/etc/passwd",
            "mailto:a@b.test#",
            "mailto:a@b.test?body=x%2526attach%253D/x",
            "mailto:a@b.test?body=%2526attach%253D",
            "mailto:a@b.test?to=a%00b@c.test",
            "mailto:a@b.test?to=a%0D%0Ab@c.test",
            "mailto:a@b.test?cc=a%0Ab@c.test",
            "mailto:a@b.test?subject=a%0D%0Abcc:x@y.test",
            "mailto:a%0D%0A@b.test",
            "mailto:a%3Fattach=/x@b.test",
            "mailto:a%26b@c.test",
            "mailto:a%23b@c.test",
            "mailto:a@b.test?body=%+4",
            "mailto:a@b.test?body=%ff",
        )) {
            assertNull(url, PopupUrlPolicy.allow(url))
        }
        for ((url, want) in listOf(
            "mailto:a@b.test?SUBJECT=Hi%20there&Body=x%26y" to "mailto:a@b.test?subject=Hi%20there&body=x%26y",
            "mailto:a@b.test" to "mailto:a@b.test",
            "mailto:?to=a@b.test" to "mailto:?to=a@b.test",
            "mailto:a@b.test?body=x%26attach%3D/x" to "mailto:a@b.test?body=x%26attach%3D%2Fx",
            "mailto:a@b.test?body=l1%0D%0Al2" to "mailto:a@b.test?body=l1%0D%0Al2",
            "mailto:a@b.test?%53ubject=a+b" to "mailto:a@b.test?subject=a%2Bb",
        )) {
            assertEquals(url, want, PopupUrlPolicy.allow(url))
        }
    }

    @Test
    fun unparseable_urls_are_dropped() {
        assertNull(PopupUrlPolicy.allow("https://exa mple.com/"))
        assertNull(PopupUrlPolicy.allow("ht!tp://example.com/"))
    }
}
