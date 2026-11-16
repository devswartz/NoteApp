#if canImport(UIKit)
// The stroke being drawn, on a Metal layer over the page: nv-ink triangles of the stroke so far
// plus the predicted touches, drawn the moment a touch arrives (not on the next display tick) and
// presented straight away. Triangles are filled opaque with 4x MSAA; a see-through tool (the
// highlighter) takes its alpha from the layer, so overlapping triangles never darken.
import Metal
import QuartzCore
import UIKit

final class LiveStrokeView: UIView {
    override class var layerClass: AnyClass { CAMetalLayer.self }
    private var metalLayer: CAMetalLayer { layer as! CAMetalLayer }

    private let device: MTLDevice?
    private let queue: MTLCommandQueue?
    private var pipeline: MTLRenderPipelineState?
    private var msaa: MTLTexture?
    private static let samples = 4

    /// Page px → this view's points: v = page * scale + offset (fixed for a stroke: scrolling is locked while drawing).
    var pageScale: CGFloat = 1
    var pageOffset: CGPoint = .zero

    override init(frame: CGRect) {
        device = MTLCreateSystemDefaultDevice()
        queue = device?.makeCommandQueue()
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isOpaque = false
        backgroundColor = .clear
        metalLayer.device = device
        metalLayer.pixelFormat = .bgra8Unorm
        metalLayer.framebufferOnly = true
        metalLayer.isOpaque = false
        metalLayer.presentsWithTransaction = false
        metalLayer.maximumDrawableCount = 3
        metalLayer.contentsScale = UIScreen.main.scale
        pipeline = makePipeline()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    var isAvailable: Bool { pipeline != nil }

    private static let shader = """
    #include <metal_stdlib>
    using namespace metal;
    struct U { float2 scale; float2 offset; float2 size; float4 color; };
    vertex float4 vmain(uint vid [[vertex_id]], const device float2 *pts [[buffer(0)]], constant U &u [[buffer(1)]]) {
        float2 v = pts[vid] * u.scale + u.offset;
        return float4(v.x / u.size.x * 2.0 - 1.0, 1.0 - v.y / u.size.y * 2.0, 0.0, 1.0);
    }
    fragment float4 fmain(constant U &u [[buffer(1)]]) { return u.color; }
    """

    private struct Uniforms {
        var scale: SIMD2<Float>
        var offset: SIMD2<Float>
        var size: SIMD2<Float>
        var color: SIMD4<Float>
    }

    private func makePipeline() -> MTLRenderPipelineState? {
        guard let device, let lib = try? device.makeLibrary(source: LiveStrokeView.shader, options: nil) else { return nil }
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = lib.makeFunction(name: "vmain")
        d.fragmentFunction = lib.makeFunction(name: "fmain")
        d.colorAttachments[0].pixelFormat = .bgra8Unorm
        d.rasterSampleCount = LiveStrokeView.samples
        return try? device.makeRenderPipelineState(descriptor: d)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let s = metalLayer.contentsScale
        metalLayer.drawableSize = CGSize(width: max(1, bounds.width * s), height: max(1, bounds.height * s))
    }

    private func msaaTexture(for size: CGSize) -> MTLTexture? {
        if let t = msaa, t.width == Int(size.width), t.height == Int(size.height) { return t }
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: Int(size.width), height: Int(size.height), mipmapped: false)
        d.textureType = .type2DMultisample
        d.sampleCount = LiveStrokeView.samples
        d.usage = .renderTarget
        d.storageMode = .private
        msaa = device?.makeTexture(descriptor: d)
        return msaa
    }

    /// Draws `triangles` (page px, x y per vertex) in `color` (0xRRGGBBAA). Empty: clears.
    func draw(triangles: [Float], color: UInt32) {
        guard let queue, let pipeline, bounds.width > 0, bounds.height > 0, let drawable = metalLayer.nextDrawable(),
              let target = msaaTexture(for: metalLayer.drawableSize), let cmd = queue.makeCommandBuffer() else { return }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].resolveTexture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .multisampleResolve
        guard let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
        if triangles.count >= 6, let device {
            var u = Uniforms(scale: SIMD2(Float(pageScale), Float(pageScale)), offset: SIMD2(Float(pageOffset.x), Float(pageOffset.y)),
                             size: SIMD2(Float(bounds.width), Float(bounds.height)),
                             color: SIMD4(Float((color >> 24) & 255) / 255, Float((color >> 16) & 255) / 255, Float((color >> 8) & 255) / 255, 1))
            let bytes = triangles.count * MemoryLayout<Float>.stride
            let buf = bytes <= 4096 ? nil : triangles.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: bytes, options: .storageModeShared) }
            enc.setRenderPipelineState(pipeline)
            if let buf { enc.setVertexBuffer(buf, offset: 0, index: 0) } else { triangles.withUnsafeBytes { enc.setVertexBytes($0.baseAddress!, length: bytes, index: 0) } }
            enc.setVertexBytes(&u, length: MemoryLayout<Uniforms>.stride, index: 1)
            enc.setFragmentBytes(&u, length: MemoryLayout<Uniforms>.stride, index: 1)
            enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: triangles.count / 2)
        }
        enc.endEncoding()
        cmd.present(drawable)
        cmd.commit()
        metalLayer.opacity = Float(color & 255) / 255
    }

    func clear() { draw(triangles: [], color: 0) }
}
#endif
