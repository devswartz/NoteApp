#if canImport(UIKit)
// The page's finished strokes, drawn as vector shapes (nv-ink path commands, as the web's
// Canvas2D draws them) inside WebKit's own scroll view for the page. Being a subview of that
// scroll view is what keeps ink and text in lockstep: UIKit moves both in the same frame, so
// nothing can drift while panning. Its bounds are page px; the zoom is its transform.
import UIKit

final class InkContentView: UIView {
    private var tileLayers: [TileKey: CALayer] = [:]
    private var paths: [String: CGPath] = [:]
    var dark = false {
        didSet { if dark != oldValue { redrawAll() } }
    }
    /// Called when WebKit takes the scroll view away (it rebuilt its layers): re-attach.
    var onDetached: (() -> Void)?
    private(set) var store: InkStore?

    init(store: InkStore) {
        self.store = store
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        isOpaque = false
        layer.anchorPoint = .zero
        layer.zPosition = 10_000 // over WebKit's own content layers in the scroll view
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Places the page: its top-left at `origin` in the scroll view's content, `size` page px, at `zoom`.
    func place(origin: CGPoint, size: CGSize, zoom: CGFloat) {
        transform = .identity
        bounds = CGRect(origin: .zero, size: size)
        layer.position = origin
        transform = CGAffineTransform(scaleX: zoom, y: zoom)
        setRenderScale((window?.screen.scale ?? UIScreen.main.scale) * zoom)
    }

    /// The pixels per page px the ink is drawn at (screen scale × zoom), so it stays sharp when a
    /// scroll view zooms it.
    func setRenderScale(_ scale: CGFloat) {
        guard abs(layer.contentsScale - scale) > 0.01 else { return }
        layer.contentsScale = scale
        for t in tileLayers.values { for s in t.sublayers ?? [] { s.contentsScale = scale } }
    }

    /// Lays out at `size` page px with no transform (inside a view that a scroll view zooms).
    func place(size: CGSize) {
        transform = .identity
        bounds = CGRect(origin: .zero, size: size)
        layer.position = .zero
        for t in tileLayers.values { t.frame = bounds }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil, superview != nil || onDetached != nil { onDetached?() }
    }

    func redrawAll() {
        guard let store else { return }
        redraw(Set(tileLayers.keys).union(store.tiles))
    }

    func redraw(_ tiles: Set<TileKey>) {
        guard let store else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for t in tiles { redrawTile(t, store.visible(in: t)) }
        CATransaction.commit()
    }

    private func path(_ e: StrokeEntry) -> CGPath {
        if let p = paths[e.id] { return p }
        let p = InkPaths.cgPath(InkEngine.path(e.blob))
        if !e.id.contains("#") { paths[e.id] = p } // overlay pieces come and go
        return p
    }

    func forget(_ ids: [String]) { for id in ids { paths[id] = nil } }

    private func redrawTile(_ key: TileKey, _ entries: [StrokeEntry]) {
        tileLayers[key]?.removeFromSuperlayer()
        tileLayers[key] = nil
        guard !entries.isEmpty else { return }
        let tile = CALayer()
        tile.frame = bounds // no clipping: a stroke may reach out of its tile
        let scale = layer.contentsScale
        for run in InkStore.runs(entries) {
            let shape = CAShapeLayer()
            let p = CGMutablePath()
            for e in run { p.addPath(path(e)) }
            shape.path = p
            shape.fillRule = .nonZero
            let c = InkRules.displayColor(run[0].info.color, dark: dark)
            shape.fillColor = UIColor(red: CGFloat((c >> 24) & 255) / 255, green: CGFloat((c >> 16) & 255) / 255, blue: CGFloat((c >> 8) & 255) / 255, alpha: 1).cgColor
            shape.opacity = Float(c & 255) / 255
            shape.contentsScale = scale
            tile.addSublayer(shape)
        }
        // Highlighters in front of text here (the web draws them under it): fine for the prototype.
        layer.addSublayer(tile)
        tileLayers[key] = tile
    }
}
#endif
