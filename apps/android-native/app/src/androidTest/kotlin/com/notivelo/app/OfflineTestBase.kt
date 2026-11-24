package com.notivelo.app

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import com.notivelo.app.edit.BoxTextView
import com.notivelo.app.edit.TextEngine
import com.notivelo.core.ViewRender
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/** Saves a screenshot of the device when a test fails (CI pulls /sdcard/Download/nv-shots). */
class ScreenshotOnFailure : TestWatcher() {
    override fun failed(e: Throwable?, description: Description) {
        try {
            val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
            device.executeShellCommand("mkdir -p /sdcard/Download/nv-shots")
            val name = description.className.substringAfterLast('.') + "-" + description.methodName
            device.executeShellCommand("screencap -p /sdcard/Download/nv-shots/$name.png")
        } catch (x: Exception) {
            // The test's own failure is the news.
        }
    }
}

/**
 * Launches the debug app on its offline source (`--es source offline`: a page of two boxes, each a REAL core editor
 * session, no server). The tests then use the app the way a person does (taps, key events, an input connection as the
 * keyboard makes one) and assert against the engine's frame (`TextEngine.render()`).
 */
abstract class OfflineTestBase {
    @get:Rule(order = 0)
    val compose = createEmptyComposeRule()

    @get:Rule(order = 1)
    val screenshots = ScreenshotOnFailure()

    protected val inst = InstrumentationRegistry.getInstrumentation()
    protected val device: UiDevice = UiDevice.getInstance(inst)
    private lateinit var scenario: ActivityScenario<MainActivity>

    @Before
    fun launchOffline() {
        val intent = Intent(inst.targetContext, MainActivity::class.java).putExtra("source", "offline")
        scenario = ActivityScenario.launch(intent)
        waitForBoxNode(FIRST)
    }

    @After
    fun closeApp() {
        scenario.close()
    }

    // Waiting ------------------------------------------------------------------------------------------------------------

    protected fun waitFor(what: String, timeoutMs: Long = 10_000, cond: () -> Boolean) {
        val end = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val ok = try { cond() } catch (e: Exception) { false }
            if (ok) return
            if (SystemClock.uptimeMillis() > end) {
                shot("timeout-" + what.take(30).replace(Regex("[^A-Za-z0-9]+"), "_"))
                throw AssertionError("Timed out waiting for $what (text=${textOrNull()?.let { "\"" + it.replace("\n", "\\n") + "\"" }})")
            }
            Thread.sleep(50)
        }
    }

    protected fun shot(name: String) {
        try {
            device.executeShellCommand("mkdir -p /sdcard/Download/nv-shots")
            device.executeShellCommand("screencap -p /sdcard/Download/nv-shots/${this.javaClass.simpleName}-$name.png")
        } catch (x: Exception) {
        }
    }

    protected fun waitForBoxNode(id: String) {
        compose.waitUntil(30_000) { compose.onAllNodesWithTag("box-$id").fetchSemanticsNodes().isNotEmpty() }
    }

    // The box being edited -----------------------------------------------------------------------------------------------

    private fun find(v: View): BoxTextView? {
        if (v is BoxTextView) return v
        if (v is ViewGroup) for (i in 0 until v.childCount) find(v.getChildAt(i))?.let { return it }
        return null
    }

    protected fun viewOrNull(): BoxTextView? {
        var out: BoxTextView? = null
        scenario.onActivity { out = find(it.window.decorView) }
        return out
    }

    protected fun view(): BoxTextView = viewOrNull() ?: throw AssertionError("No box is being edited")
    protected fun engine(): TextEngine = view().input.engine
    protected fun frame(): ViewRender = engine().render()
    protected fun text(): String = frame().view.text
    private fun textOrNull(): String? = try { viewOrNull()?.input?.engine?.render()?.view?.text } catch (e: Exception) { null }
    protected fun selection(): Pair<Int, Int> = frame().view.selection.let { it.anchor.toInt() to it.head.toInt() }

    /** Tap a box that is shown as text (Compose touch), wait until its editor has the focus. */
    protected fun startEditing(id: String = FIRST) {
        waitForBoxNode(id)
        compose.onNodeWithTag("box-$id").performClick()
        waitFor("the box editor to have focus") { viewOrNull()?.isFocused == true }
    }

    protected fun waitForText(expected: String) = waitFor("text \"${expected.replace("\n", "\\n")}\"") { text() == expected }

    // Input --------------------------------------------------------------------------------------------------------------

    /** Key events as a hardware keyboard sends them (the window's key dispatch, no input method). */
    protected fun typeKeys(s: String) {
        inst.sendStringSync(s)
        inst.waitForIdleSync()
    }

    protected fun key(code: Int, meta: Int = 0) {
        val now = SystemClock.uptimeMillis()
        inst.sendKeySync(KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta))
        inst.sendKeySync(KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0, meta))
        inst.waitForIdleSync()
    }

    protected fun ctrl(code: Int, shift: Boolean = false) {
        var meta = KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
        if (shift) meta = meta or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
        key(code, meta)
    }

    /** What an input method does: ask the view for its input connection (with a real EditorInfo) and call it on the UI thread. */
    protected fun ime(block: (InputConnection, EditorInfo) -> Unit) {
        val v = view()
        var failure: Throwable? = null
        inst.runOnMainSync {
            try {
                val info = EditorInfo()
                val ic = v.onCreateInputConnection(info) ?: throw AssertionError("The view gave no input connection")
                block(ic, info)
            } catch (t: Throwable) {
                failure = t
            }
        }
        failure?.let { throw it }
        inst.waitForIdleSync()
    }

    protected fun <T> imeRead(block: (InputConnection) -> T): T {
        var out: T? = null
        ime { ic, _ -> out = block(ic) }
        @Suppress("UNCHECKED_CAST")
        return out as T
    }

    protected fun clipboardText(): String? {
        var out: String? = null
        inst.runOnMainSync {
            val cm = inst.targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            out = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(inst.targetContext)?.toString()
        }
        return out
    }

    /** A finger on the view at (x, y) in the view's own pixels, held for [holdMs] (a tap when short, a long press when long). */
    protected fun touch(x: Float, y: Float, holdMs: Long) {
        val v = view()
        val down = SystemClock.uptimeMillis()
        inst.runOnMainSync { v.dispatchTouchEvent(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0)) }
        Thread.sleep(holdMs)
        inst.runOnMainSync { v.dispatchTouchEvent(MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0)) }
        inst.waitForIdleSync()
    }

    protected fun density(): Float = inst.targetContext.resources.displayMetrics.density

    companion object {
        const val FIRST = "default"
        const val SECOND = "b2"
    }
}
