package com.notivelo.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.text.KeyboardActions
import com.notivelo.app.look.LocalPhone
import com.notivelo.app.look.WText
import com.notivelo.app.look.WebType
import com.notivelo.app.look.pal

/**
 * Sign-in (LOOK.md 4.13, `Login.tsx`, `sign-in.png`): a card on a `--bg-subtle` page with an accent glow.
 * The server field is hidden (it defaults to the production server): long-press the app name to show it.
 */
@Composable
fun SignInScreen(
    server: String,
    busy: Boolean,
    error: String?,
    onSignIn: (server: String, email: String, password: String) -> Unit,
    modifier: Modifier = Modifier,
    onNotYet: (String) -> Unit = {},
    /** Draw the email field focused (the references were captured with it focused). */
    emailFocusedLook: Boolean = false,
) {
    val p = pal()
    val phone = LocalPhone.current
    // Em-sized text follows the body size: 14 on a tablet, 15 on a phone.
    val k = if (phone) 15f / 14f else 1f
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var serverText by rememberSaveable(server) { mutableStateOf(server) }
    var advanced by rememberSaveable { mutableStateOf(false) }
    val cardShape = RoundedCornerShape(16.dp)

    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .drawBehind {
                drawRect(p.bgSubtle)
                // radial-gradient(1200px 600px at 50% -10%, accent-soft, transparent)
                val center = Offset(size.width / 2f, -0.1f * size.height)
                val rx = 1200.dp.toPx()
                withTransform({ scale(1f, 0.5f, pivot = center) }) {
                    drawCircle(
                        brush = Brush.radialGradient(listOf(p.accentSoft, Color.Transparent), center = center, radius = rx),
                        radius = rx,
                        center = center,
                    )
                }
            },
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(min = maxHeight)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Column(
                Modifier
                    .widthIn(max = 400.dp)
                    .fillMaxWidth()
                    .shadow(16.dp, cardShape, clip = false, ambientColor = p.shadow, spotColor = p.shadow)
                    .background(p.bgElevated, cardShape)
                    .border(1.dp, p.border, cardShape)
                    .padding(32.dp),
            ) {
                Row(
                    Modifier.pointerInput(Unit) { detectTapGestures(onLongPress = { advanced = !advanced }) },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    AppMark(34)
                    WText("Notivelo", 17f, p.text, weight = 700)
                }
                WText(
                    "Welcome back", 22f, p.text, Modifier.padding(top = if (phone) 23.dp else 20.dp, bottom = 17.dp),
                    weight = 700, lineHeight = 1.3f, tracking = -0.02f,
                )
                WText(
                    "Notes and tasks, connected — for you and your team.", 14f * k, p.textMuted,
                    lineHeight = 1.5f, maxLines = 3,
                )
                Column(
                    Modifier.padding(top = 24.dp, bottom = 18.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    if (advanced) {
                        Field("Server", serverText, { serverText = it }, k, phone, KeyboardType.Uri, ImeAction.Next)
                    }
                    Field("Email", email, { email = it }, k, phone, KeyboardType.Email, ImeAction.Next, lookFocused = emailFocusedLook)
                    Field(
                        "Password", password, { password = it }, k, phone, KeyboardType.Password, ImeAction.Go,
                        secret = true, onGo = { onSignIn(serverText, email, password) },
                    )
                    WText(
                        "Forgot password?", 12.5f * k, p.accent, Modifier.tappable { onNotYet("Password reset") },
                        weight = 500, lineHeight = 1.3f,
                    )
                    if (error != null) {
                        WText(error, 13f * k, p.danger, lineHeight = 1.4f, maxLines = 3)
                    }
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(if (phone) 44.dp else 40.dp)
                            .alpha(if (busy) 0.6f else 1f)
                            .background(p.accentSolid, RoundedCornerShape(8.dp))
                            .tappable { if (!busy) onSignIn(serverText, email, password) },
                        contentAlignment = Alignment.Center,
                    ) {
                        WText(if (busy) "Signing in…" else "Sign in", 15f, p.textOnAccent, weight = 500, lineHeight = 1f)
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                    WText("New here? ", 12.5f * k, p.textMuted)
                    WText("Create an account", 12.5f * k, p.accent, Modifier.tappable { onNotYet("Creating an account") }, weight = 500)
                }
                WText(
                    "Privacy · Terms · Support", 12.5f * k, p.textMuted,
                    Modifier.fillMaxWidth().padding(top = 14.dp), align = TextAlign.Center,
                )
                androidx.compose.foundation.layout.Spacer(Modifier.height(14.dp))
            }
        }
    }
}

/** The app mark (the web's logo tile): accent square, white rounded square with a check. */
@Composable
fun AppMark(size: Int) {
    Box(
        Modifier
            .size(size.dp)
            .shadow(1.dp, RoundedCornerShape((size * 9 / 34f).dp), clip = false)
            .background(Color(0xFF4F46E5), RoundedCornerShape((size * 9 / 34f).dp))
            .drawBehind {
                val s = this.size.width
                val box = s * 0.5f
                val tl = Offset((s - box) / 2f, (s - box) / 2f)
                drawRoundRect(Color.White, tl, Size(box, box), CornerRadius(s * 0.12f))
                val path = androidx.compose.ui.graphics.Path().apply {
                    moveTo(tl.x + box * 0.25f, tl.y + box * 0.52f)
                    lineTo(tl.x + box * 0.43f, tl.y + box * 0.70f)
                    lineTo(tl.x + box * 0.76f, tl.y + box * 0.32f)
                }
                drawPath(path, Color(0xFF4F46E5), style = Stroke(width = s * 0.075f, cap = androidx.compose.ui.graphics.StrokeCap.Round, join = androidx.compose.ui.graphics.StrokeJoin.Round))
            },
    )
}

@Composable
private fun Field(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    k: Float,
    phone: Boolean,
    keyboardType: KeyboardType,
    ime: ImeAction,
    secret: Boolean = false,
    lookFocused: Boolean = false,
    onGo: () -> Unit = {},
) {
    val p = pal()
    var focused by remember { mutableStateOf(false) }
    val on = focused || lookFocused
    val shape = RoundedCornerShape(8.dp)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        WText(label, 13f * k, p.text, weight = 500, lineHeight = 1.3f)
        BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = WebType.style(if (phone) 16f else 14f, 400, 1.3f).copy(color = p.text),
            cursorBrush = SolidColor(p.text),
            visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = ime),
            keyboardActions = KeyboardActions(onGo = { onGo() }),
            modifier = Modifier
                .fillMaxWidth()
                .height(40.dp)
                .onFocusChanged { focused = it.isFocused }
                .drawBehind {
                    if (on) {
                        // 3 dp --accent-soft ring around the border
                        val inflate = 1.5.dp.toPx()
                        drawRoundRect(
                            p.accentSoft,
                            Offset(-inflate, -inflate),
                            Size(size.width + 2 * inflate, size.height + 2 * inflate),
                            CornerRadius(8.dp.toPx() + inflate),
                            style = Stroke(width = 3.dp.toPx()),
                        )
                    }
                }
                .background(p.bg, shape)
                .border(1.dp, if (on) p.accent else p.border, shape),
            decorationBox = { inner ->
                Box(Modifier.fillMaxSize().padding(horizontal = 10.dp), contentAlignment = Alignment.CenterStart) { inner() }
            },
        )
    }
}
