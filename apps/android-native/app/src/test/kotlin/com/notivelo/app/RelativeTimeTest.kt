package com.notivelo.app

import com.notivelo.app.ui.relativeTime
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test

class RelativeTimeTest {
    private val now = Instant.parse("2026-11-21T12:00:00Z")

    @Test
    fun words() {
        assertEquals("just now", relativeTime("2026-11-21T11:59:30Z", now))
        assertEquals("1m ago", relativeTime("2026-11-21T11:59:00Z", now))
        assertEquals("12m ago", relativeTime("2026-11-21T11:48:00Z", now))
        assertEquals("2h ago", relativeTime("2026-11-21T09:30:00Z", now))
        assertEquals("4d ago", relativeTime("2026-11-17T12:00:00Z", now))
        assertEquals("", relativeTime("not a date", now))
    }
}
