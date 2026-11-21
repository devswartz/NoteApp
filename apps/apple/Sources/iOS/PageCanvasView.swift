import NotiveloCore
import SwiftUI
import UIKit

/// Read-only native page (M4 groundwork): the page's text boxes at their saved positions, each a
/// TextKit 2 text view, on a surface with the page colour and rule lines, in a UIScrollView for
/// native pan and pinch zoom. No editing yet; the editor engine (nv-editor) comes next.
/// A live page redraws on every change, keeping the zoom and scroll position.
struct PageCanvasView: UIViewRepresentable {
    let page: PageSnapshot

    func makeUIView(context: Context) -> PageScrollView {
        PageScrollView()
    }

    func updateUIView(_ view: PageScrollView, context: Context) {
        view.show(page)
    }
}

final class PageScrollView: UIScrollView, UIScrollViewDelegate {
    /// Page units are CSS pixels in the web app; one page unit is one point here.
    static let margin: CGFloat = 40
    private let surface = PageSurfaceView()
    private var shownID: String?
    private var shownInfo: PageInfo?
    private var shownTasks: [String: TaskLine] = [:]
    private var shownTitles: [String: String] = [:]

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        minimumZoomScale = 0.25
        maximumZoomScale = 4
        bouncesZoom = true
        alwaysBounceVertical = true
        backgroundColor = .systemBackground
        addSubview(surface)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func show(_ page: PageSnapshot) {
        let samePage = page.id == shownID
        guard !samePage || page.info != shownInfo || page.tasks != shownTasks || page.pageTitles != shownTitles else { return }
        shownID = page.id
        shownInfo = page.info
        shownTasks = page.tasks
        shownTitles = page.pageTitles
        // A change to the open page keeps where the reader is: redraw at zoom 1, then put zoom and offset back.
        let keptZoom = samePage ? zoomScale : 1
        let keptOffset = samePage ? contentOffset : .zero
        zoomScale = 1
        surface.subviews.forEach { $0.removeFromSuperview() }

        let renderer = PageTextRenderer(tasks: page.tasks, pageTitles: page.pageTitles)
        var frames: [(CGRect, UITextView, Double)] = []
        for shown in page.boxes {
            let box = shown.box
            let text = UITextView(usingTextLayoutManager: true)
            text.isEditable = false
            text.isScrollEnabled = false
            text.isSelectable = true
            text.backgroundColor = .clear
            text.textContainerInset = UIEdgeInsets(top: 4, left: 6, bottom: 4, right: 6)
            text.textContainer.lineFragmentPadding = 0
            text.attributedText = renderer.render(shown.content)
            text.accessibilityIdentifier = "box:\(box.id)"
            let width = CGFloat(box.w)
            let height = text.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
            frames.append((CGRect(x: box.x, y: box.y, width: width, height: height), text, box.z))
        }

        // The surface starts at the page origin or the top-left box, whichever is further out
        // (boxes can sit at negative positions), plus a margin.
        let union = frames.reduce(CGRect(x: 0, y: 0, width: 686, height: 400)) { $0.union($1.0) }
        let origin = CGPoint(x: min(union.minX, 0) - Self.margin, y: min(union.minY, 0) - Self.margin)
        for (frame, text, _) in frames.sorted(by: { $0.2 < $1.2 }) { // stacking order: higher z in front
            text.frame = frame.offsetBy(dx: -origin.x, dy: -origin.y)
            surface.addSubview(text)
        }
        let size = CGSize(width: union.maxX - origin.x + Self.margin, height: union.maxY - origin.y + Self.margin * 4)
        surface.frame = CGRect(origin: .zero, size: size)
        surface.configure(settings: page.info.settings, pageOrigin: CGPoint(x: -origin.x, y: -origin.y))
        contentSize = size
        if keptZoom != 1 { zoomScale = keptZoom }
        let maxOffset = CGPoint(x: max(contentSize.width - bounds.width, 0), y: max(contentSize.height - bounds.height, 0))
        contentOffset = CGPoint(x: min(max(keptOffset.x, -adjustedContentInset.left), maxOffset.x),
                                y: min(max(keptOffset.y, -adjustedContentInset.top), maxOffset.y + adjustedContentInset.bottom))
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { surface }

    @objc private func toggleZoom(_ tap: UITapGestureRecognizer) {
        if zoomScale > 1.01 {
            setZoomScale(1, animated: true)
        } else {
            let p = tap.location(in: surface)
            zoom(to: CGRect(x: p.x - bounds.width / 4, y: p.y - bounds.height / 4, width: bounds.width / 2, height: bounds.height / 2), animated: true)
        }
    }
}

/// The page itself: its colour and rule lines or grid, 28 points apart from the page origin, as the web app draws them.
final class PageSurfaceView: UIView {
    static let rule: CGFloat = 28
    private var rules = "none"
    private var pageOrigin = CGPoint.zero

    func configure(settings: PageSettings, pageOrigin: CGPoint) {
        rules = settings.rules
        self.pageOrigin = pageOrigin
        backgroundColor = Self.tint(settings.color)
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard rules == "lines" || rules == "grid", let ctx = UIGraphicsGetCurrentContext() else { return }
        ctx.setStrokeColor(UIColor.separator.cgColor)
        ctx.setLineWidth(1 / max(contentScaleFactor, 1))
        let step = Self.rule
        var y = pageOrigin.y.truncatingRemainder(dividingBy: step)
        while y < bounds.maxY {
            ctx.move(to: CGPoint(x: rect.minX, y: y))
            ctx.addLine(to: CGPoint(x: rect.maxX, y: y))
            y += step
        }
        if rules == "grid" {
            var x = pageOrigin.x.truncatingRemainder(dividingBy: step)
            while x < bounds.maxX {
                ctx.move(to: CGPoint(x: x, y: rect.minY))
                ctx.addLine(to: CGPoint(x: x, y: rect.maxY))
                x += step
            }
        }
        ctx.strokePath()
    }

    /// Page colours from src/styles.css (--page-*), light and dark.
    static func tint(_ name: String) -> UIColor {
        let colors: [String: (UInt32, UInt32)] = [
            "yellow": (0xFDF8E3, 0x221F1A), "green": (0xEFF7F0, 0x1A1F1C), "blue": (0xEEF4FB, 0x1A1D24),
            "purple": (0xF5F1FB, 0x1E1B24), "pink": (0xFCF1F5, 0x221B1F), "grey": (0xF4F4F5, 0x1F1F22),
        ]
        guard let (light, dark) = colors[name] else { return .systemBackground }
        return UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) }
    }
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
