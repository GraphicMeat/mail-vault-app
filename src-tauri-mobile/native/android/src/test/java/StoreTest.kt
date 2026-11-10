package com.mailvault.mvnative

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StoreTest {
    // The server (website/api/store-billing.js) compares Play's obfuscatedExternalAccountId with
    // sha256 hex of the lower-case install id; StoreKit prints UUIDs upper case.
    @Test
    fun obfuscated_id_is_sha256_hex_of_the_lowercase_install_id() {
        val expected = "d1bfaf4aff653cb27984b7d978e51a7d406d1572df95d205c254beb18dc134d3"
        assertEquals(expected, Store.obfuscatedId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"))
        assertEquals(expected, Store.obfuscatedId("3F2504E0-4F89-11D3-9A0C-0305E82C3301"))
        val id = Store.obfuscatedId("00000000-0000-4000-8000-000000000000")
        assertEquals(64, id.length)
        assertTrue(id.all { it in '0'..'9' || it in 'a'..'f' })
    }

    @Test
    fun the_two_product_ids() {
        assertEquals(listOf("com.mailvault.app.premium.monthly", "com.mailvault.app.premium.yearly"), Store.PRODUCT_IDS)
    }

    // An acknowledged own purchase goes over only on the daily sweep (the engine may have missed the
    // server's answer); another install's never goes over by itself; a pending one never.
    @Test
    fun which_purchases_go_over_by_themselves() {
        assertTrue(Store.handsOver(purchased = true, acknowledged = false, own = true, sweep = false))
        assertFalse(Store.handsOver(purchased = true, acknowledged = true, own = true, sweep = false))
        assertTrue(Store.handsOver(purchased = true, acknowledged = true, own = true, sweep = true))
        assertFalse(Store.handsOver(purchased = true, acknowledged = false, own = false, sweep = true))
        assertFalse(Store.handsOver(purchased = false, acknowledged = false, own = true, sweep = true))
    }

    @Test
    fun the_sweep_is_daily_and_survives_a_clock_set_back() {
        val day = Store.ACK_SWEEP_MS
        assertTrue(Store.sweepDue(now = day, last = 0L))
        assertFalse(Store.sweepDue(now = 2 * day - 1, last = day))
        assertTrue(Store.sweepDue(now = 2 * day, last = day))
        assertTrue(Store.sweepDue(now = day - 1, last = day))
    }
}
