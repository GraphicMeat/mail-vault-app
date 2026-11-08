package com.mailvault.mvnative

import android.content.Intent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NotifierTest {
    // A tap's intent opens its message; the same intent replayed when Android recreates the
    // activity from Recents (process death, then the task's card) must not open it again.
    @Test
    fun an_intent_replayed_from_recents_is_no_tap() {
        assertTrue(Notifier.isFreshTap(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        assertFalse(Notifier.isFreshTap(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY))
        assertFalse(Notifier.isFreshTap(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY))
    }
}
