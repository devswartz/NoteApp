package com.notivelo.app.ui.page

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.notivelo.app.data.AppState
import com.notivelo.app.data.InkShape
import com.notivelo.app.data.PageStatus
import com.notivelo.app.data.TreeIndex
import com.notivelo.app.edit.BoxEditor
import com.notivelo.app.edit.EditContext
import com.notivelo.app.edit.LocalEditContext
import com.notivelo.app.edit.LocalPageActions
import com.notivelo.app.edit.PageChoice
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.LocalPagePalette
import com.notivelo.app.look.PagePalettes
import com.notivelo.app.look.Palette
import com.notivelo.app.look.WText
import com.notivelo.app.look.WebType
import com.notivelo.app.look.parseHex
import com.notivelo.app.look.pal
import com.notivelo.app.ui.LocalNow
import com.notivelo.app.ui.LocalToday
import com.notivelo.app.ui.hairline
import com.notivelo.app.ui.relativeTime
import com.notivelo.app.ui.tappable
import com.notivelo.app.edit.EditingBox
import com.notivelo.core.BoxContent
import com.notivelo.core.ContentNode
import com.notivelo.core.NodeKind
import com.notivelo.core.PageMeta

/**
 * A page open on screen (LOOK.md 4.5): the bar, then the title and "Edited" line over the canvas: boxes at their saved
 * places on a surface that scrolls both ways (tablets), or stacked in reading order (phones). Read-only: the content is
 * what the core returned for the page (`PageInfo.content`, `LivePage.info`), and a remote change redraws it.
 */
@Composable
fun PageScreen(
    state: AppState,
    meta: PageMeta,
    index: TreeIndex,
    phone: Boolean,
    modifier: Modifier = Modifier,
    scrollPx: Int = 0,
) {
    val chrome = pal()
    val p = pagePalette(state)
    val view = state.page?.takeIf { it.pageId == meta.id }
    val onThisPage = state.tasks.filter { it.pageId == meta.id }.map { it.id }.toSet()
    val taskCount = state.tasks.count { !it.done && (it.pageId == meta.id || it.parentId in onThisPage) }
    Column(modifier.fillMaxSize().background(p.bg)) {
        PageBar(state, meta, index, phone, taskCount, view?.status ?: PageStatus.Connecting, p, view?.canUndo == true, view?.canRedo == true)
        val info = view?.info
        val today = LocalToday.current
        val env = remember(p, phone, state.tasks, state.tree, state.user, today) {
            PageEnv(
                palette = p, phone = phone,
                tasks = state.tasks.associateBy { it.id },
                pageTitles = state.otherPageTitles + (state.tree?.pages?.associate { it.id to it.title.ifEmpty { "Untitled" } } ?: emptyMap()),
                meId = state.user?.id, meName = state.user?.name ?: "", meColor = state.user?.color ?: "#6366f1",
                today = today,
            )
        }
        val sub = "Edited ${relativeTime(meta.updatedAt, LocalNow.current)}" + if (state.preview) " by you" else ""
        val tint = info?.settings?.color ?: "none"
        val page = if (tint == "none") p else PagePalettes.tinted(p, tint)
        val envTinted = if (page === p) env else PageEnv(page, phone, env.tasks, env.pageTitles, env.meId, env.meName, env.meColor, env.today)
        val choices = remember(state.tree) {
            state.tree?.pages.orEmpty().filter { !it.locked && it.id != meta.id }.map { pg ->
                val sec = index.section(pg.sectionId)
                val nb = sec?.let { index.notebookOf(it) }
                PageChoice(pg.id, pg.title, listOfNotNull(nb?.name, sec?.name).joinToString(" / "))
            }
        }
        val editCtx = remember(view?.editing, choices, state.members, info, view?.rev) { EditContext(view?.editing, choices, state.members, info) }
        val ruled = BoxGeom.ruled(info?.settings?.rules)
        Box(Modifier.weight(1f).fillMaxWidth().background(page.bg)) {
          CompositionLocalProvider(LocalEditContext provides editCtx) {
            when {
                meta.locked -> Message("Locked pages open in the web app for now.", page)
                view?.status == PageStatus.NoAccess -> Message("You no longer have access to this page.", page)
                phone -> PhoneCanvas(meta, sub, PageLayout.withDefault(info?.boxes.orEmpty(), info?.content.orEmpty()), info?.content.orEmpty(), view?.ink.orEmpty(), info?.settings?.rules ?: "none", envTinted, scrollPx, view?.editing?.boxId, view?.info != null && !state.preview)
                else -> TabletCanvas(meta, sub, PageLayout.withDefault(info?.boxes.orEmpty(), info?.content.orEmpty()), info?.content.orEmpty(), view?.ink.orEmpty(), info?.settings?.rules ?: "none", envTinted, scrollPx, ruled, view?.rev ?: 0)
            }
          }
        }
    }
}

@Composable
private fun pagePalette(state: AppState): Palette = LocalPagePalette.current

@Composable
private fun Message(text: String, p: Palette) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        WText(text, 14f, p.textMuted, lineHeight = 1.5f, maxLines = 3)
    }
}

// Bar ----------------------------------------------------------------------------------------------------------------

@Composable
private fun PageBar(state: AppState, meta: PageMeta, index: TreeIndex, phone: Boolean, taskCount: Int, status: PageStatus, p: Palette, canUndo: Boolean, canRedo: Boolean) {
    val actions = LocalPageActions.current
    val section = index.section(meta.sectionId)
    val notebook = section?.let { index.notebookOf(it) }
    Row(
        Modifier
            .fillMaxWidth()
            .height(if (phone) 44.dp else 48.dp)
            .background(p.bg.copy(alpha = 0.88f))
            .then(if (phone) Modifier else Modifier.hairline(p.border))
            .padding(start = if (phone) 16.dp else 20.dp, end = if (phone) 8.dp else 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(if (phone) 12.dp else 6.dp),
    ) {
        if (phone) {
            Spacer(Modifier.weight(1f))
            Box(Modifier.testTag("page-undo").size(32.dp).alpha(if (canUndo) 1f else 0.4f).then(if (canUndo) Modifier.tappable { actions.undoPage() } else Modifier), contentAlignment = Alignment.Center) { LIcon(Ic.undo2, 18.dp, p.text2) }
            Box(Modifier.testTag("page-redo").size(32.dp).alpha(if (canRedo) 1f else 0.4f).then(if (canRedo) Modifier.tappable { actions.redoPage() } else Modifier), contentAlignment = Alignment.Center) { LIcon(Ic.redo2, 18.dp, p.text2) }
        } else {
            if (notebook != null) {
                Box(Modifier.size(8.dp).background(parseHex(notebook.color), CircleShape))
                WText(notebook.name, 13f, p.text2, lineHeight = 1.5f)
                LIcon(Ic.chevronRight, 14.dp, p.textMuted)
            }
            if (section != null) WText(section.name, 13f, p.text2, lineHeight = 1.5f)
            Spacer(Modifier.weight(1f))
            val (label, icon) = when (status) {
                PageStatus.Synced -> "Saved" to Ic.check
                PageStatus.Offline -> "Offline" to Ic.circleCheck
                else -> "Connecting…" to Ic.clock
            }
            Row(Modifier.padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                LIcon(icon, 14.dp, p.text2)
                WText(label, 12f, p.text2, lineHeight = 1.3f)
            }
        }
        IconWithBadge(Ic.listTodo, taskCount, p)
        IconWithBadge(Ic.messageSquare, 0, p)
        Row(
            Modifier.height(28.dp).background(p.bgElevated, RoundedCornerShape(8.dp)).border(1.dp, p.border, RoundedCornerShape(8.dp)).padding(horizontal = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            LIcon(Ic.userPlus, 14.dp, p.text)
            WText("Share", 13f, p.text, weight = 500, lineHeight = 1f)
        }
        Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) { LIcon(Ic.ellipsis, 18.dp, p.text2) }
    }
}

@Composable
private fun IconWithBadge(icon: Int, badge: Int, p: Palette) {
    Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) {
        LIcon(icon, 18.dp, p.text2)
        if (badge > 0) {
            Box(
                Modifier.align(Alignment.TopEnd).offset(x = 2.dp, y = (-1).dp).defaultMinSize(minWidth = 16.dp, minHeight = 16.dp).background(p.accentSolid, RoundedCornerShape(50)).padding(horizontal = 4.dp),
                contentAlignment = Alignment.Center,
            ) { WText("$badge", 10f, Color.White, weight = 600, lineHeight = 1f) }
        }
    }
}

// Header -------------------------------------------------------------------------------------------------------------

@Composable
private fun PageHeader(meta: PageMeta, sub: String, p: Palette, phone: Boolean, modifier: Modifier = Modifier) {
    val icon = meta.icon?.takeIf { it.isNotEmpty() }
    val titleSize = if (phone) 28f else 36f
    Column(modifier) {
        if (icon != null) {
            val size = if (phone) 44f else 56f
            Box(Modifier.height((size * 1.1f + 4f).dp), contentAlignment = Alignment.TopStart) {
                Text(icon, fontSize = size.sp, lineHeight = (size * 1.1f).sp, maxLines = 1, softWrap = false, overflow = TextOverflow.Clip)
            }
        } else {
            Row(Modifier.height((if (phone) 44 else 28).dp), verticalAlignment = Alignment.CenterVertically) {
                if (phone) {
                    LIcon(Ic.faceSlightlySmilingPlus, 15.dp, p.textMuted)
                    Spacer(Modifier.width(8.dp))
                    WText("Add icon", 13f, p.textMuted, weight = 500, lineHeight = 1.3f)
                }
            }
        }
        Spacer(Modifier.height(4.dp))
        Text(
            text = meta.title.ifEmpty { "Untitled" },
            color = if (meta.title.isEmpty()) p.borderStrong else p.text,
            style = WebType.style(titleSize, 700, 1.2f, -0.025f),
            modifier = Modifier.heightIn(min = (titleSize * 1.2f).dp),
        )
        Spacer(Modifier.height(6.dp))
        WText(sub, 12.5f, p.textMuted, Modifier.height(18.75.dp), lineHeight = 1.5f)
    }
}

// Tablet canvas --------------------------------------------------------------------------------------------------------

@Composable
private fun TabletCanvas(
    meta: PageMeta, sub: String, boxes: List<com.notivelo.core.PageBox>, content: List<BoxContent>,
    ink: List<InkShape>, rules: String, env: PageEnv, scrollPx: Int, ruled: Boolean, rev: Int,
) {
    val p = env.palette
    val density = LocalDensity.current
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val visibleW = maxWidth
        val visibleH = maxHeight
        val hasIcon = !meta.icon.isNullOrEmpty()
        val laidOut = remember(boxes, visibleW, hasIcon) { PageLayout.place(boxes, visibleW.value, hasIcon) }
        // A drag or resize shows at once; the core's write comes back as a new page (rev) and replaces it.
        var drag by remember { mutableStateOf<BoxDrag?>(null) }
        LaunchedEffect(rev) { drag = null }
        val shownDrag = drag
        val editingId = LocalEditContext.current.editing?.boxId
        val placed = if (shownDrag == null) laidOut else laidOut.map {
            if (it.id == shownDrag.id) it.copy(x = PageLayout.ORIGIN_X + shownDrag.x.toFloat(), y = PageLayout.ORIGIN_Y + PageLayout.iconShift(hasIcon, false) + shownDrag.y.toFloat(), width = shownDrag.w.toFloat()) else it
        }
        val byId = remember(content) { content.associateBy { it.boxId ?: "default" } }
        val oy = PageLayout.ORIGIN_Y + PageLayout.iconShift(hasIcon, false)
        val scroll = rememberScrollState(scrollPx)
        val h = rememberScrollState()
        val ruleColor = PagePalettes.rule(p)
        val pens = ink.filter { !it.highlighter }
        val glows = ink.filter { it.highlighter }
        val actions = LocalPageActions.current
        val density1 = density.density
        val editingNow by rememberUpdatedState(editingId)
        val ruledNow by rememberUpdatedState(ruled)
        CanvasSurface(
            placed = placed, visibleW = visibleW, visibleH = visibleH, hasIcon = hasIcon, editingId = editingId,
            modifier = Modifier
                .verticalScroll(scroll)
                .horizontalScroll(h)
                .pointerInput(Unit) {
                    detectTapGestures { o ->
                        // Empty canvas: a first tap ends editing; otherwise a box is made there (the web's click-to-create).
                        val xDp = o.x / density1
                        val yDp = o.y / density1
                        if (editingNow != null || yDp < oy) {
                            actions.stopEditing()
                        } else {
                            val (bx, by) = BoxGeom.atClick((xDp - PageLayout.ORIGIN_X).toDouble(), (yDp - oy).toDouble(), ruledNow)
                            actions.createBox(bx, by)
                        }
                    }
                }
                .drawBehind { drawRules(rules, oy, ruleColor) }
                .drawWithContent {
                    drawInk(glows, PageLayout.ORIGIN_X, oy)
                    drawContent()
                    drawInk(pens, PageLayout.ORIGIN_X, oy)
                },
            header = {
                PageHeader(meta, sub, p, false, Modifier.width((visibleW - (PageLayout.ORIGIN_X + PageLayout.BOX_PAD_X).dp - 40.dp).coerceAtLeast(100.dp)))
            },
            box = { b ->
                val live = editingId == b.id
                val hooks = if (live) BoxFrameHooks(
                    x = (b.x - PageLayout.ORIGIN_X).toDouble(), y = (b.y - oy).toDouble(), w = b.width.toDouble(), ruled = ruled,
                    onPreview = { drag = it },
                    onCommit = { d ->
                        drag = d
                        if (d.moved) actions.moveBox(d.id, d.x, d.y)
                        if (d.resized) actions.resizeBox(d.id, d.w)
                        if (!d.moved && !d.resized) drag = null
                    },
                ) else null
                BoxView(b.id, byId[b.id], env, Modifier.width(b.width.dp + if (live) BoxGeom.FRAME_END.dp else 0.dp), hooks)
            },
        )
    }
}

/** The surface: header at the top, boxes at their places; sized past the boxes (240 right, 320 down). */
@Composable
private fun CanvasSurface(
    placed: List<PlacedBox>,
    visibleW: Dp,
    visibleH: Dp,
    hasIcon: Boolean,
    editingId: String?,
    modifier: Modifier,
    header: @Composable () -> Unit,
    box: @Composable (PlacedBox) -> Unit,
) {
    Layout(
        content = {
            Box { header() }
            for (b in placed) Box { box(b) }
        },
        modifier = modifier,
    ) { measurables, constraints ->
        val headerX = (PageLayout.ORIGIN_X + PageLayout.BOX_PAD_X).dp.roundToPx()
        val top = 32.dp.roundToPx()
        val header = measurables[0].measure(Constraints(maxWidth = (visibleW.roundToPx() - headerX).coerceAtLeast(0), maxHeight = Constraints.Infinity))
        val frameEnd = BoxGeom.FRAME_END.dp.roundToPx()
        val frameTop = BoxGeom.FRAME_TOP.dp.roundToPx()
        val items = placed.mapIndexed { i, b ->
            val w = b.width.dp.roundToPx() + if (b.id == editingId) frameEnd else 0
            b to measurables[i + 1].measure(Constraints(minWidth = w, maxWidth = w, maxHeight = Constraints.Infinity))
        }
        val maxX = items.maxOfOrNull { (b, pl) -> b.x.dp.roundToPx() + pl.width } ?: 0
        val maxY = items.maxOfOrNull { (b, pl) -> b.y.dp.roundToPx() + pl.height - if (b.id == editingId) frameTop else 0 } ?: 0
        val oy = (PageLayout.ORIGIN_Y + PageLayout.iconShift(hasIcon, false)).dp.roundToPx()
        val width = maxOf(maxX + 240.dp.roundToPx(), visibleW.roundToPx())
        val height = maxOf(maxY + 320.dp.roundToPx(), oy + 320.dp.roundToPx(), visibleH.roundToPx())
        layout(width, height) {
            header.placeRelative(headerX, top)
            for ((b, pl) in items) pl.placeRelative(b.x.dp.roundToPx(), b.y.dp.roundToPx() - if (b.id == editingId) frameTop else 0)
        }
    }
}

/**
 * A box: its blocks as drawn text, or, once tapped (and the page is live), the text view over the box's editor session.
 * On the tablet canvas the box being edited also wears the web's frame ([frame] set): a drag bar on its top edge and a
 * width handle on its right edge.
 */
@Composable
private fun BoxView(boxId: String, content: BoxContent?, env: PageEnv, modifier: Modifier = Modifier, frame: BoxFrameHooks? = null) {
    val p = env.palette
    val nodes = content?.nodes.orEmpty()
    val ec = LocalEditContext.current
    val actions = LocalPageActions.current
    val editing = ec.editing?.takeIf { it.boxId == boxId }
    if (editing != null) {
        if (frame == null) BoxEditor(editing, env, ec, modifier) else FramedEditor(editing, env, ec, frame, modifier)
        return
    }
    val tap = Modifier.pointerInput(boxId) { detectTapGestures { o -> actions.startEditing(boxId, o.x, o.y) } }
    Column(modifier.testTag("box-$boxId").then(tap).padding(horizontal = PageLayout.BOX_PAD_X.dp, vertical = PageLayout.BOX_PAD_Y.dp)) {
        if (isBlank(nodes)) {
            WText("Type '/' for commands…", env.body, p.textPlaceholder, lineHeight = 1.7f)
        } else {
            BlockList(nodes, env)
        }
    }
}

/**
 * The selected box (`.canvas-box:focus-within` with its `.canvas-box-move` and `.canvas-box-width`): a 1 dp strong border on
 * the page colour, a bar over the top edge (12 dp shown, 28 to grab) that moves it, a pill on the right edge (28 x 80 to grab)
 * that sets its width. The frame's room above and to the right is part of this composable, so the box does not shift.
 */
@Composable
private fun FramedEditor(editing: EditingBox, env: PageEnv, ec: EditContext, frame: BoxFrameHooks, modifier: Modifier) {
    val p = env.palette
    val shape = RoundedCornerShape(6.dp)
    val density = LocalDensity.current.density
    val hooks by rememberUpdatedState(frame)
    val id = editing.boxId
    Box(modifier) {
        Box(Modifier.padding(top = BoxGeom.FRAME_TOP.dp, end = BoxGeom.FRAME_END.dp).fillMaxWidth().background(p.bg, shape).border(1.dp, p.borderStrong, shape)) {
            BoxEditor(editing, env, ec, Modifier.fillMaxWidth())
        }
        Box(
            Modifier.align(Alignment.TopStart).padding(end = BoxGeom.FRAME_END.dp).fillMaxWidth().height(28.dp).pointerInput(id) {
                var start: BoxFrameHooks? = null
                var total = Offset.Zero
                var last: BoxDrag? = null
                detectDragGestures(
                    onDragStart = { start = hooks; total = Offset.Zero; last = null },
                    onDrag = { change, amount ->
                        change.consume()
                        total += amount
                        val st = start
                        if (st != null) {
                            val (nx, ny) = BoxGeom.moved(st.x, st.y, (total.x / density).toDouble(), (total.y / density).toDouble(), st.ruled)
                            val d = BoxDrag(id, nx, ny, st.w, moved = true)
                            last = d
                            st.onPreview(d)
                        }
                    },
                    onDragEnd = {
                        val st = start
                        val d = last
                        if (st != null && d != null && (d.x != st.x || d.y != st.y)) st.onCommit(d) else st?.onPreview(null)
                    },
                    onDragCancel = { start?.onPreview(null) },
                )
            },
        ) {
            Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(12.dp).background(p.bgPressed, RoundedCornerShape(topStart = 6.dp, topEnd = 6.dp)))
        }
        Box(
            Modifier.align(Alignment.CenterEnd).offset(y = (BoxGeom.FRAME_TOP / 2).dp).width(28.dp).height(80.dp).pointerInput(id) {
                var start: BoxFrameHooks? = null
                var total = 0f
                var last: BoxDrag? = null
                detectDragGestures(
                    onDragStart = { start = hooks; total = 0f; last = null },
                    onDrag = { change, amount ->
                        change.consume()
                        total += amount.x
                        val st = start
                        if (st != null) {
                            val d = BoxDrag(id, st.x, st.y, BoxGeom.resized(st.w, (total / density).toDouble()), resized = true)
                            last = d
                            st.onPreview(d)
                        }
                    },
                    onDragEnd = {
                        val st = start
                        val d = last
                        if (st != null && d != null && d.w != st.w) st.onCommit(d) else st?.onPreview(null)
                    },
                    onDragCancel = { start?.onPreview(null) },
                )
            },
        ) {
            Box(Modifier.align(Alignment.Center).size(width = 3.dp, height = 24.dp).background(p.borderStrong, RoundedCornerShape(2.dp)))
        }
    }
}

/** A lone empty paragraph: the one box that shows the placeholder unfocused. */
internal fun isBlank(nodes: List<ContentNode>): Boolean =
    nodes.size == 1 && nodes[0].kind == NodeKind.Paragraph && nodes[0].children.isEmpty()

private fun DrawScope.drawRules(rules: String, originY: Float, color: Color) {
    if (rules != "lines" && rules != "grid") return
    val step = 28.dp.toPx()
    val top = (originY + 7f).dp.toPx()
    var y = top + step - 1.dp.toPx()
    while (y < size.height) {
        drawRect(color, Offset(0f, y), androidx.compose.ui.geometry.Size(size.width, 1.dp.toPx()))
        y += step
    }
    if (rules == "grid") {
        var x = 0f
        while (x < size.width) {
            drawRect(color, Offset(x, top), androidx.compose.ui.geometry.Size(1.dp.toPx(), size.height - top))
            x += step
        }
    }
}

private fun inkPath(ops: FloatArray): Path {
    val path = Path()
    path.fillType = PathFillType.NonZero
    var i = 0
    while (i < ops.size) {
        when (ops[i].toInt()) {
            0 -> { path.moveTo(ops[i + 1], ops[i + 2]); i += 3 }
            1 -> { path.lineTo(ops[i + 1], ops[i + 2]); i += 3 }
            2 -> { path.addOval(Rect(Offset(ops[i + 1], ops[i + 2]), ops[i + 3])); i += 4 }
            3 -> { path.close(); i += 1 }
            else -> i = ops.size
        }
    }
    return path
}

/** Strokes in page points from the surface's origin: highlighters go under the boxes, pens over (core `inkStrokes` + `inkOutline`). */
private fun DrawScope.drawInk(shapes: List<InkShape>, originX: Float, originY: Float) {
    if (shapes.isEmpty()) return
    val d = density
    val ox = originX.dp.toPx()
    val oy = originY.dp.toPx()
    withTransform({
        translate(ox, oy)
        scale(d, d, Offset.Zero)
    }) {
        for (s in shapes) drawPath(inkPath(s.ops), Color(s.argb))
    }
}

// Phone canvas ---------------------------------------------------------------------------------------------------------

@Composable
private fun PhoneCanvas(
    meta: PageMeta, sub: String, boxes: List<com.notivelo.core.PageBox>, content: List<BoxContent>,
    ink: List<InkShape>, rules: String, env: PageEnv, scrollPx: Int, editingId: String?, live: Boolean,
) {
    val p = env.palette
    val stacked = remember(boxes, content, editingId) { PageLayout.stack(boxes, content, editingId) }
    val byId = remember(content) { content.associateBy { it.boxId ?: "default" } }
    val hasIcon = !meta.icon.isNullOrEmpty()
    val shift = PageLayout.iconShift(hasIcon, true)
    val scroll = rememberScrollState(scrollPx)
    val pens = ink.filter { !it.highlighter }
    val glows = ink.filter { it.highlighter }
    val originY = PageLayout.PHONE_ORIGIN_Y + shift
    val ruleColor = PagePalettes.rule(p)
    val actions = LocalPageActions.current
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .pointerInput(Unit) { detectTapGestures { actions.stopEditing() } }
            .drawBehind { drawRules(rules, originY, ruleColor) }
            .drawWithContent {
                drawInk(glows, 0f, originY)
                drawContent()
                drawInk(pens, 0f, originY)
            },
    ) {
        Spacer(Modifier.height(12.dp))
        PageHeader(meta, sub, p, true, Modifier.padding(horizontal = 20.dp))
        Spacer(Modifier.height((22f + 6f - PageLayout.BOX_PAD_Y + PageLayout.phoneTopGap(stacked.size)).dp))
        for (b in stacked) {
            BoxView(b.id, byId[b.id], env, Modifier.padding(horizontal = 9.dp).fillMaxWidth())
            Spacer(Modifier.height(3.5.dp))
            Box(Modifier.padding(horizontal = 20.dp).fillMaxWidth().height(1.dp).background(p.border))
            Spacer(Modifier.height(5.dp))
        }
        // The web's stacked layout has no free placement: a box is added under the others.
        if (live) {
            Row(
                Modifier.padding(horizontal = 12.dp, vertical = 4.dp).tappable { val (bx, by) = BoxGeom.below(boxes); actions.createBox(bx, by) }.padding(horizontal = 8.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                LIcon(Ic.plus, 15.dp, p.textMuted)
                WText("Add a text box", 14f, p.textMuted, lineHeight = 1.4f)
            }
        }
        Spacer(Modifier.height(96.dp))
    }
}
