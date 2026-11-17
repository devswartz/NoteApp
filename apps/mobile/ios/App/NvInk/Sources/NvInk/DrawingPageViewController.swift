#if canImport(UIKit)
// The native drawing page (docs/PLAN_INK.md, Stage 1): one UIKit page, with no web view, to answer
// "does this feel like Notability?". A UIScrollView owns pan (momentum, bounce) and pinch zoom; the
// paper, the title and the finished ink are subviews of the one zoomed view, so they scale together.
// The live stroke is drawn with Metal over the scroll view the moment touches arrive (coalesced and
// predicted), and finished ink is vector layers redrawn sharp when a zoom ends. Fingers pan and
// zoom; the Pencil draws (a finger too with finger drawing on). Pencil double-tap toggles the
// eraser; a two-finger tap undoes and a three-finger tap redoes. Saved on the device only.
import UIKit

public final class DrawingPageViewController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate, UIPencilInteractionDelegate, UITextFieldDelegate {
    private var doc: DrawingDoc
    private let saveURL: URL?

    private let scroller = UIScrollView()
    private let page = UIView()
    private let rules = CAShapeLayer()
    private let titleField = UITextField()
    private let ink: InkContentView
    private let live = LiveStrokeView()
    private let eraserRing = CAShapeLayer()
    private let toolbar = UIView()
    private let zoomLabel = UILabel()
    private var toolButtons: [String: UIButton] = [:]
    private var colorButtons: [UInt32: UIButton] = [:]
    private var widthButtons: [Float: UIButton] = [:]
    private let undoButton = UIButton(type: .system)
    private let redoButton = UIButton(type: .system)
    private let fingerButton = UIButton(type: .system)

    private lazy var pen = PenInputRecognizer(target: nil, action: nil)
    private var builder: StrokeBuilder?
    private var erasing: (op: DrawingOp, last: CGPoint?)?
    private var laidOut = false
    private var pageHeight = DrawingPage.minHeight

    // The tool, as the toolbar sets it.
    private var tool = "pen"
    private var lastDrawTool = "pen"
    private var penColor: UInt32 = 0x1F2328FF
    private var penWidth: Float = 2.5
    private var highlighterColor: UInt32 = 0xFFD43B66
    private var fingerDrawing = false
    private let eraserRadius: Float = 10

    private static let penColors: [UInt32] = [0x1F2328FF, 0x1F6FEBFF, 0xD1242FFF, 0x1A7F37FF]
    private static let highlighterColors: [UInt32] = [0xFFD43B66, 0x4CC9F066, 0xF783AC66, 0x8CE99A66]
    private static let penWidths: [Float] = [1.5, 2.5, 5]

    /// The page saved at `saveURL` (a new one when there's none), or an unsaved page.
    public init(saveURL: URL?) {
        self.saveURL = saveURL
        doc = saveURL.flatMap { try? Data(contentsOf: $0) }.flatMap(DrawingDoc.decode) ?? DrawingDoc()
        ink = InkContentView(store: doc.store)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Where the prototype keeps its page: Application Support/DrawingPrototype/page.nvd.
    public static func defaultSaveURL() -> URL? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("DrawingPrototype") else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("page.nvd")
    }

    public override var prefersStatusBarHidden: Bool { false }
    public override var prefersHomeIndicatorAutoHidden: Bool { true }
    // Keep system edge gestures from stealing strokes that start at the bottom edge.
    public override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .bottom }

    // MARK: - Views

    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(white: 0.9, alpha: 1)

        scroller.delegate = self
        scroller.minimumZoomScale = DrawingPage.minZoom
        scroller.maximumZoomScale = DrawingPage.maxZoom
        scroller.alwaysBounceVertical = true
        scroller.alwaysBounceHorizontal = true
        scroller.bouncesZoom = true
        scroller.contentInsetAdjustmentBehavior = .never
        scroller.keyboardDismissMode = .interactive
        scroller.delaysContentTouches = false
        scroller.showsHorizontalScrollIndicator = false
        // Fingers pan and zoom; the Pencil never does.
        scroller.panGestureRecognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        scroller.pinchGestureRecognizer?.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        view.addSubview(scroller)

        page.backgroundColor = .white
        page.layer.shadowColor = UIColor.black.cgColor
        page.layer.shadowOpacity = 0.12
        page.layer.shadowRadius = 6
        page.layer.shadowOffset = CGSize(width: 0, height: 1)
        scroller.addSubview(page)

        rules.strokeColor = UIColor(red: 0.62, green: 0.75, blue: 0.9, alpha: 0.55).cgColor
        rules.lineWidth = 1
        rules.fillColor = nil
        page.layer.addSublayer(rules)

        titleField.text = doc.title
        titleField.placeholder = "Untitled drawing"
        titleField.font = .systemFont(ofSize: 40, weight: .bold)
        titleField.textColor = UIColor(white: 0.12, alpha: 1)
        titleField.returnKeyType = .done
        titleField.delegate = self
        titleField.addTarget(self, action: #selector(titleChanged), for: .editingChanged)
        page.addSubview(titleField)

        ink.dark = false
        page.addSubview(ink)

        view.addSubview(live)
        eraserRing.fillColor = UIColor(white: 0.5, alpha: 0.12).cgColor
        eraserRing.strokeColor = UIColor(white: 0.35, alpha: 0.8).cgColor
        eraserRing.lineWidth = 1
        eraserRing.isHidden = true
        view.layer.addSublayer(eraserRing)

        pen.onBegan = { [weak self] t, e in self?.began(t, e) }
        pen.onMoved = { [weak self] t, e in self?.moved(t, e) }
        pen.onEnded = { [weak self] t, e, cancelled in self?.ended(t, e, cancelled) }
        pen.delegate = self
        scroller.addGestureRecognizer(pen)

        let undoTap = UITapGestureRecognizer(target: self, action: #selector(undo))
        undoTap.numberOfTouchesRequired = 2
        let redoTap = UITapGestureRecognizer(target: self, action: #selector(redo))
        redoTap.numberOfTouchesRequired = 3
        for g in [undoTap, redoTap] {
            g.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
            g.delegate = self
            scroller.addGestureRecognizer(g)
        }
        undoTap.require(toFail: redoTap)

        let pencil = UIPencilInteraction()
        pencil.delegate = self
        view.addInteraction(pencil)

        buildToolbar()
        applyTool()
        redrawAll()
    }

    private func symbolButton(_ name: String, _ label: String, _ action: Selector) -> UIButton {
        let b = UIButton(type: .system)
        b.setImage(UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: 20, weight: .regular)), for: .normal)
        b.accessibilityLabel = label
        b.addTarget(self, action: action, for: .touchUpInside)
        b.widthAnchor.constraint(equalToConstant: 44).isActive = true
        b.heightAnchor.constraint(equalToConstant: 44).isActive = true
        b.layer.cornerRadius = 10
        return b
    }

    private func buildToolbar() {
        toolbar.backgroundColor = UIColor(white: 0.97, alpha: 0.96)
        toolbar.layer.shadowColor = UIColor.black.cgColor
        toolbar.layer.shadowOpacity = 0.08
        toolbar.layer.shadowRadius = 2
        toolbar.layer.shadowOffset = CGSize(width: 0, height: 1)
        view.addSubview(toolbar)

        let close = symbolButton("xmark", "Close", #selector(closePage))
        let tools: [(String, String, String)] = [
            ("pen", "pencil.tip", "Pen"), ("highlighter", "highlighter", "Highlighter"),
            ("eraser", "eraser", "Eraser (whole strokes)"), ("partialEraser", "eraser.line.dashed", "Partial eraser"),
        ]
        var items: [UIView] = [close, gap()]
        for (id, symbol, label) in tools {
            let b = symbolButton(symbol, label, #selector(toolTapped(_:)))
            b.accessibilityIdentifier = id
            toolButtons[id] = b
            items.append(b)
        }
        items.append(gap())
        for c in Self.penColors {
            let b = UIButton(type: .custom)
            b.accessibilityLabel = "Colour"
            b.tag = Int(c >> 8)
            b.addTarget(self, action: #selector(colorTapped(_:)), for: .touchUpInside)
            b.widthAnchor.constraint(equalToConstant: 36).isActive = true
            b.heightAnchor.constraint(equalToConstant: 44).isActive = true
            let dot = UIView(frame: CGRect(x: 7, y: 11, width: 22, height: 22))
            dot.isUserInteractionEnabled = false
            dot.layer.cornerRadius = 11
            dot.tag = 1
            b.addSubview(dot)
            colorButtons[c] = b
            items.append(b)
        }
        items.append(gap())
        for (i, w) in Self.penWidths.enumerated() {
            let b = UIButton(type: .custom)
            b.accessibilityLabel = ["Fine", "Medium", "Thick"][i]
            b.tag = i
            b.addTarget(self, action: #selector(widthTapped(_:)), for: .touchUpInside)
            b.widthAnchor.constraint(equalToConstant: 36).isActive = true
            b.heightAnchor.constraint(equalToConstant: 44).isActive = true
            let d = CGFloat(4 + i * 4)
            let dot = UIView(frame: CGRect(x: 18 - d / 2, y: 22 - d / 2, width: d, height: d))
            dot.isUserInteractionEnabled = false
            dot.layer.cornerRadius = d / 2
            dot.backgroundColor = UIColor(white: 0.2, alpha: 1)
            b.addSubview(dot)
            b.layer.cornerRadius = 10
            widthButtons[w] = b
            items.append(b)
        }
        items.append(gap())
        fingerButton.setImage(UIImage(systemName: "hand.draw", withConfiguration: UIImage.SymbolConfiguration(pointSize: 20)), for: .normal)
        fingerButton.accessibilityLabel = "Draw with a finger"
        fingerButton.addTarget(self, action: #selector(fingerTapped), for: .touchUpInside)
        fingerButton.widthAnchor.constraint(equalToConstant: 44).isActive = true
        fingerButton.layer.cornerRadius = 10
        items.append(fingerButton)
        items.append(gap())
        for (b, symbol, label, action) in [(undoButton, "arrow.uturn.backward", "Undo", #selector(undo)), (redoButton, "arrow.uturn.forward", "Redo", #selector(redo))] {
            b.setImage(UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 20)), for: .normal)
            b.accessibilityLabel = label
            b.addTarget(self, action: action, for: .touchUpInside)
            b.widthAnchor.constraint(equalToConstant: 44).isActive = true
            items.append(b)
        }
        items.append(gap())
        zoomLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        zoomLabel.textColor = .secondaryLabel
        zoomLabel.widthAnchor.constraint(equalToConstant: 48).isActive = true
        items.append(zoomLabel)
        let more = symbolButton("ellipsis.circle", "More", #selector(noop))
        more.menu = UIMenu(children: [
            UIAction(title: "Fit width", image: UIImage(systemName: "arrow.left.and.right")) { [weak self] _ in self?.fitWidth(animated: true) },
            UIAction(title: "Fill with test strokes (3,000)", image: UIImage(systemName: "scribble")) { [weak self] _ in self?.fillTest() },
            UIAction(title: "Clear page", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in self?.clearPage() },
        ])
        more.showsMenuAsPrimaryAction = true
        items.append(more)

        let stack = UIStackView(arrangedSubviews: items)
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        toolbar.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: toolbar.centerXAnchor),
            stack.bottomAnchor.constraint(equalTo: toolbar.bottomAnchor, constant: -4),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: toolbar.leadingAnchor, constant: 8),
        ])
    }

    private func gap() -> UIView {
        let v = UIView()
        v.widthAnchor.constraint(equalToConstant: 14).isActive = true
        return v
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let top = view.safeAreaInsets.top + 52
        toolbar.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: top)
        let area = CGRect(x: 0, y: top, width: view.bounds.width, height: view.bounds.height - top)
        if scroller.frame != area {
            scroller.frame = area
            live.frame = area
        }
        if !laidOut {
            laidOut = true
            layoutPage()
            fitWidth(animated: false)
        }
        centre()
    }

    private func layoutPage() {
        pageHeight = DrawingPage.height(current: pageHeight, inkBottom: doc.inkBottom)
        let z = scroller.zoomScale
        let size = CGSize(width: DrawingPage.width, height: pageHeight)
        // The zoomed view's bounds are page px; its frame (and the content size) is that times the zoom.
        page.bounds = CGRect(origin: .zero, size: size)
        page.center = CGPoint(x: size.width * z / 2, y: size.height * z / 2)
        scroller.contentSize = CGSize(width: size.width * z, height: size.height * z)
        page.layer.shadowPath = UIBezierPath(rect: page.bounds).cgPath
        ink.place(size: size)
        titleField.frame = CGRect(x: 64, y: 56, width: size.width - 128, height: 56)
        let p = CGMutablePath()
        var y = DrawingPage.firstRule
        while y < size.height {
            p.move(to: CGPoint(x: 0, y: y))
            p.addLine(to: CGPoint(x: size.width, y: y))
            y += DrawingPage.ruleGap
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        rules.frame = page.bounds
        rules.path = p
        CATransaction.commit()
    }

    private func fitWidth(animated: Bool) {
        let z = DrawingPage.fitZoom(viewWidth: scroller.bounds.width)
        scroller.setZoomScale(z, animated: animated)
        if !animated {
            centre()
            scroller.contentOffset = CGPoint(x: -scroller.contentInset.left, y: -scroller.contentInset.top)
        }
        zoomEnded()
    }

    /// Keeps the paper centred when it is narrower (or shorter) than the view.
    private func centre() {
        let x = DrawingPage.centringInset(view: scroller.bounds.width, content: scroller.contentSize.width)
        let y = max(16, DrawingPage.centringInset(view: scroller.bounds.height, content: scroller.contentSize.height))
        let inset = UIEdgeInsets(top: y, left: max(x, 16), bottom: y, right: max(x, 16))
        if scroller.contentInset != inset { scroller.contentInset = inset }
        updateZoomLabel()
    }

    private func updateZoomLabel() { zoomLabel.text = "\(Int((scroller.zoomScale * 100).rounded()))%" }

    // MARK: - Zoom

    public func viewForZooming(in scrollView: UIScrollView) -> UIView? { page }

    public func scrollViewDidZoom(_ scrollView: UIScrollView) { centre() }

    public func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) { zoomEnded() }

    /// At rest after a zoom: ink, rules and title are drawn again for the new zoom, so they're sharp.
    private func zoomEnded() {
        let screen = view.window?.screen.scale ?? UIScreen.main.scale
        let s = min(DrawingPage.maxRenderScale, screen * scroller.zoomScale)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ink.setRenderScale(s)
        rules.contentsScale = s
        CATransaction.commit()
        setContentScale(titleField, s)
        updateZoomLabel()
    }

    private func setContentScale(_ v: UIView, _ s: CGFloat) {
        v.contentScaleFactor = s
        v.layer.contentsScale = s
        for sub in v.subviews { setContentScale(sub, s) }
    }

    // MARK: - Tools

    private var drawsNow: Bool { tool == "pen" || tool == "highlighter" }
    private var erasesNow: Bool { tool == "eraser" || tool == "partialEraser" }

    private func applyTool() {
        for (id, b) in toolButtons {
            let on = id == tool
            b.backgroundColor = on ? UIColor.systemBlue.withAlphaComponent(0.15) : .clear
            b.tintColor = on ? .systemBlue : UIColor(white: 0.25, alpha: 1)
        }
        let hl = tool == "highlighter"
        let colors = hl ? Self.highlighterColors : Self.penColors
        for (i, c) in Self.penColors.enumerated() {
            guard let b = colorButtons[c], let dot = b.viewWithTag(1) else { continue }
            let shown = colors[i]
            dot.backgroundColor = uiColor(shown | 0xFF)
            let on = (hl ? highlighterColor : penColor) == shown
            dot.layer.borderWidth = on ? 3 : 0
            dot.layer.borderColor = UIColor.systemBlue.cgColor
            b.isHidden = erasesNow
        }
        for (w, b) in widthButtons {
            b.backgroundColor = w == penWidth ? UIColor.systemBlue.withAlphaComponent(0.15) : .clear
            b.isHidden = erasesNow || hl
        }
        fingerButton.tintColor = fingerDrawing ? .systemBlue : UIColor(white: 0.25, alpha: 1)
        fingerButton.backgroundColor = fingerDrawing ? UIColor.systemBlue.withAlphaComponent(0.15) : .clear
        var types = [NSNumber(value: UITouch.TouchType.pencil.rawValue)]
        if fingerDrawing { types.append(NSNumber(value: UITouch.TouchType.direct.rawValue)) }
        pen.allowedTouchTypes = types
        // With finger drawing on, one finger draws and two fingers pan.
        scroller.panGestureRecognizer.minimumNumberOfTouches = fingerDrawing ? 2 : 1
        undoButton.isEnabled = doc.canUndo
        redoButton.isEnabled = doc.canRedo
    }

    private func uiColor(_ c: UInt32) -> UIColor {
        UIColor(red: CGFloat((c >> 24) & 255) / 255, green: CGFloat((c >> 16) & 255) / 255, blue: CGFloat((c >> 8) & 255) / 255, alpha: CGFloat(c & 255) / 255)
    }

    @objc private func toolTapped(_ b: UIButton) {
        guard let id = b.accessibilityIdentifier else { return }
        tool = id
        if drawsNow { lastDrawTool = id }
        applyTool()
    }

    @objc private func colorTapped(_ b: UIButton) {
        guard let i = Self.penColors.firstIndex(where: { colorButtons[$0] === b }) else { return }
        if tool == "highlighter" { highlighterColor = Self.highlighterColors[i] } else {
            penColor = Self.penColors[i]
            if !drawsNow { tool = "pen"; lastDrawTool = "pen" }
        }
        applyTool()
    }

    @objc private func widthTapped(_ b: UIButton) {
        penWidth = Self.penWidths[b.tag]
        applyTool()
    }

    @objc private func fingerTapped() {
        fingerDrawing.toggle()
        applyTool()
    }

    @objc private func noop() {}

    @objc private func closePage() {
        save()
        dismiss(animated: true)
    }

    public func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        tool = erasesNow ? lastDrawTool : "eraser"
        applyTool()
    }

    // MARK: - Undo

    @objc private func undo() {
        guard builder == nil, erasing == nil, let tiles = doc.undo() else { return }
        ink.redraw(tiles)
        changed()
    }

    @objc private func redo() {
        guard builder == nil, erasing == nil, let tiles = doc.redo() else { return }
        ink.redraw(tiles)
        changed()
    }

    private func clearPage() {
        ink.redraw(doc.clear())
        changed()
    }

    private func changed() {
        applyTool()
        if DrawingPage.height(current: pageHeight, inkBottom: doc.inkBottom) > pageHeight { layoutPage() }
        save()
    }

    private var saveScheduled = false

    private func save() {
        guard let url = saveURL, !saveScheduled else { return }
        saveScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self else { return }
            self.saveScheduled = false
            let data = self.doc.encoded()
            DispatchQueue.global(qos: .utility).async { try? data.write(to: url, options: .atomic) }
        }
    }

    @objc private func titleChanged() {
        doc.title = titleField.text ?? ""
        save()
    }

    public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return true
    }

    private func redrawAll() { ink.redrawAll() }

    // MARK: - Gestures

    public func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        g !== pen && other !== pen
    }

    public func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard g === pen else { return true }
        // A finger on the title edits it; the Pencil draws over it.
        if touch.type != .pencil, touch.view?.isDescendant(of: titleField) == true { return false }
        return drawsNow || erasesNow
    }

    // MARK: - Drawing

    private func sample(_ t: UITouch) -> (x: Float, y: Float, pressure: Float, altitude: Float, azimuth: Float, t: Double) {
        let p = t.preciseLocation(in: page)
        let pencil = t.type == .pencil
        let pressure: CGFloat = pencil ? (t.maximumPossibleForce > 0 ? min(1, max(0.05, t.force / t.maximumPossibleForce)) : 0.5) : 0.5
        return (Float(p.x), Float(p.y), Float(pressure), Float(pencil ? t.altitudeAngle : .pi / 2), Float(pencil ? t.azimuthAngle(in: page) : 0), t.timestamp * 1000)
    }

    /// Page px → the live layer's points, as the scroll view shows the page right now.
    private func mapLive() {
        live.pageScale = scroller.zoomScale
        live.pageOffset = page.convert(CGPoint.zero, to: live)
    }

    private func began(_ t: UITouch, _ e: UIEvent) {
        // Stop a flick in its tracks and hold the page still while the pen is down (a resting palm can't pan it).
        scroller.setContentOffset(scroller.contentOffset, animated: false)
        scroller.isScrollEnabled = false
        scroller.pinchGestureRecognizer?.isEnabled = false
        if titleField.isFirstResponder { titleField.resignFirstResponder() }
        mapLive()
        if erasesNow {
            erasing = (DrawingOp(), nil)
            moved(t, e)
            return
        }
        let pencil = t.type == .pencil
        let hl = tool == "highlighter"
        builder = StrokeBuilder(tool: hl ? InkToolID.highlighter : InkToolID.pen, color: hl ? highlighterColor : penColor,
                                width: hl ? 14 : penWidth, z: doc.nextZ, flags: pencil ? InkFlag.pressure | InkFlag.tilt : 0)
        moved(t, e)
    }

    private func moved(_ t: UITouch, _ e: UIEvent) {
        let touches = e.coalescedTouches(for: t) ?? [t]
        if erasing != nil {
            var track: [Float] = []
            if let l = erasing?.last { track += [Float(l.x), Float(l.y)] }
            for c in touches {
                let s = sample(c)
                track += [s.x, s.y]
                erasing?.last = CGPoint(x: CGFloat(s.x), y: CGFloat(s.y))
            }
            showEraser(at: t.location(in: view))
            erase(track)
            return
        }
        guard let b = builder else { return }
        for c in touches {
            let s = sample(c)
            b.push(x: s.x, y: s.y, pressure: s.pressure, altitude: s.altitude, azimuth: s.azimuth, t: s.t)
        }
        let predicted = (e.predictedTouches(for: t) ?? []).flatMap { p -> [Float] in
            let s = sample(p)
            return [s.x, s.y, s.pressure]
        }
        live.draw(triangles: b.previewTriangles(predicted: predicted), color: b.color)
    }

    private func ended(_ t: UITouch, _ e: UIEvent?, _ cancelled: Bool) {
        scroller.isScrollEnabled = true
        scroller.pinchGestureRecognizer?.isEnabled = true
        if let er = erasing {
            erasing = nil
            eraserRing.isHidden = true
            doc.record(er.op)
            changed()
            return
        }
        guard let b = builder else { return }
        builder = nil
        guard !cancelled, let blob = b.finish() else {
            b.cancel()
            live.clear()
            return
        }
        ink.redraw(doc.commit(DrawingOp(added: [(id: DrawingDoc.newID(), blob: blob)])))
        // The finished stroke shows in this frame; the live layer clears on the next, so it never blinks.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.builder == nil else { return }
            self.live.clear()
        }
        changed()
    }

    private func showEraser(at p: CGPoint) {
        let r = CGFloat(eraserRadius) * scroller.zoomScale
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        eraserRing.path = UIBezierPath(ovalIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)).cgPath
        eraserRing.isHidden = false
        CATransaction.commit()
    }

    /// Erases along `track` (page px) right away; the whole gesture is one undo step.
    private func erase(_ track: [Float]) {
        guard var er = erasing, track.count >= 2 else { return }
        let r = eraserRadius
        let xs = stride(from: 0, to: track.count, by: 2).map { CGFloat(track[$0]) }
        let ys = stride(from: 1, to: track.count, by: 2).map { CGFloat(track[$0]) }
        let box = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!).insetBy(dx: -CGFloat(r), dy: -CGFloat(r))
        let partial = tool == "partialEraser"
        var step = DrawingOp()
        for e in doc.store.visible() where e.rect.intersects(box) {
            let pieces: [Data]
            if partial {
                guard let p = InkEngine.erase(e.blob, track: track, radius: r) else { continue }
                pieces = p
            } else {
                guard InkEngine.hitPath(e.blob, track: track, radius: r) else { continue }
                pieces = []
            }
            step.removed.append((id: e.id, blob: e.blob))
            // A piece made earlier in this gesture never was on the page: it just goes.
            if let i = er.op.added.firstIndex(where: { $0.id == e.id }) { er.op.added.remove(at: i) } else { er.op.removed.append((id: e.id, blob: e.blob)) }
            for p in pieces {
                let piece = (id: DrawingDoc.newID(), blob: p)
                step.added.append(piece)
                er.op.added.append(piece)
            }
        }
        erasing = er
        if !step.isEmpty { ink.redraw(doc.applyUnrecorded(step)) }
    }

    // MARK: - Test page

    /// 3,000 scribbled strokes down the page (one undo step), for the pan and zoom check.
    private func fillTest() {
        var op = DrawingOp()
        var z = doc.nextZ
        var seed: UInt64 = 42
        func rnd() -> Float {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Float(seed >> 40) / Float(1 << 24)
        }
        for i in 0..<3000 {
            let row = Float(i / 12), col = Float(i % 12)
            let x0 = 60 + col * 74, y0 = 200 + row * 36
            let b = StrokeBuilder(tool: InkToolID.pen, color: Self.penColors[i % 4], width: 2, z: z, flags: InkFlag.pressure)
            for k in 0..<24 {
                let a = Float(k) / 23
                b.push(x: x0 + a * 56, y: y0 + sin(a * 12 + rnd()) * 8, pressure: 0.3 + 0.5 * sin(a * 3.1), altitude: 1, azimuth: 0, t: Double(k) * 8)
            }
            if let blob = b.finish() { op.added.append((id: DrawingDoc.newID(), blob: blob)) }
            z = ZKeys.after(z)
        }
        ink.redraw(doc.commit(op))
        changed()
    }
}
#endif
