// Swift over the ink engine's C ABI (crates/nv-ink/src/ffi.rs, include/nv_ink.h). Every buffer
// the engine hands out is copied into Swift and freed here, so callers never see raw pointers.
import Foundation
import NvInkFFI

/// Tools as the blob stores them.
public enum InkToolID {
    public static let pen: UInt8 = 0
    public static let highlighter: UInt8 = 1
}

/// Header flags as the blob stores them.
public enum InkFlag {
    public static let tilt: UInt8 = 1
    public static let pressure: UInt8 = 2
}

/// Path commands from InkEngine.path: MOVE x y, LINE x y, CIRCLE cx cy r, CLOSE.
public enum InkOp {
    public static let move: Float = 0
    public static let line: Float = 1
    public static let circle: Float = 2
    public static let close: Float = 3
}

/// A stroke's header.
public struct StrokeInfo: Equatable {
    public var tool: UInt8
    /// 0xRRGGBBAA
    public var color: UInt32
    public var width: Float
    public var count: Int
    /// Covers all the ink, width included (page px).
    public var minX: Double, minY: Double, maxX: Double, maxY: Double
    public var z: String

    public var isEmpty: Bool { count == 0 || maxX < minX }
    public var isHighlighter: Bool { tool == InkToolID.highlighter }
}

public enum InkEngine {
    static func floats(_ f: NvFloats) -> [Float] {
        defer { nv_ink_floats_free(f) }
        guard let p = f.ptr, f.len > 0 else { return [] }
        return Array(UnsafeBufferPointer(start: p, count: f.len))
    }

    static func bytes(_ b: NvBuf) -> Data {
        defer { nv_ink_buf_free(b) }
        guard let p = b.ptr, b.len > 0 else { return Data() }
        return Data(bytes: p, count: b.len)
    }

    static func withBlob<T>(_ blob: Data, _ body: (UnsafePointer<UInt8>?, Int) -> T) -> T {
        blob.withUnsafeBytes { raw in body(raw.bindMemory(to: UInt8.self).baseAddress, raw.count) }
    }

    public static var formatVersion: UInt8 { nv_ink_format_version() }

    public static func info(_ blob: Data) -> StrokeInfo? {
        var out = [Double](repeating: 0, count: 11)
        let ok = out.withUnsafeMutableBufferPointer { o in withBlob(blob) { nv_ink_info($0, $1, o.baseAddress) } }
        guard ok else { return nil }
        let z = String(decoding: withBlob(blob) { bytes(nv_ink_z($0, $1)) }, as: UTF8.self)
        return StrokeInfo(tool: UInt8(out[1]), color: UInt32(out[2]), width: Float(out[3]), count: Int(out[6]),
                          minX: out[7], minY: out[8], maxX: out[9], maxY: out[10], z: z)
    }

    /// Path commands (see InkOp); empty when the blob doesn't decode.
    public static func path(_ blob: Data) -> [Float] { withBlob(blob) { floats(nv_ink_path($0, $1)) } }

    /// Triangles (x, y per vertex); empty when the blob doesn't decode.
    public static func triangles(_ blob: Data) -> [Float] { withBlob(blob) { floats(nv_ink_triangles($0, $1)) } }

    /// Whether a disc of radius r dragged along track (flat x, y) touches the stroke's ink.
    public static func hitPath(_ blob: Data, track: [Float], radius: Float) -> Bool {
        track.withUnsafeBufferPointer { t in withBlob(blob) { nv_ink_hit_path($0, $1, t.baseAddress, track.count / 2, radius) } }
    }

    /// The partial eraser: nil when it misses; otherwise the pieces left (none: the whole stroke went).
    public static func erase(_ blob: Data, track: [Float], radius: Float) -> [Data]? {
        var out = NvBuf(ptr: nil, len: 0, cap: 0)
        let hit = track.withUnsafeBufferPointer { t in withBlob(blob) { nv_ink_erase($0, $1, t.baseAddress, track.count / 2, radius, &out) } }
        guard hit else { return nil }
        return unframe(bytes(out))
    }

    /// A blob from points (flat x, y, pressure, altitude, azimuth, t).
    public static func encode(tool: UInt8, color: UInt32, width: Float, z: String, flags: UInt8, created: Double, points: [Float]) -> Data {
        points.withUnsafeBufferPointer { p in
            z.withCString { bytes(nv_ink_encode(tool, color, width, $0, flags, created, p.baseAddress, points.count / 6)) }
        }
    }

    /// Splits framed blobs: u32 count, then a u32 length and the bytes of each (little-endian).
    public static func unframe(_ d: Data) -> [Data] {
        let b = [UInt8](d)
        func u32(_ i: Int) -> Int { Int(b[i]) | Int(b[i + 1]) << 8 | Int(b[i + 2]) << 16 | Int(b[i + 3]) << 24 }
        guard b.count >= 4 else { return [] }
        var out: [Data] = []
        var at = 4
        for _ in 0..<u32(0) {
            guard at + 4 <= b.count else { break }
            let n = u32(at)
            at += 4
            guard at + n <= b.count else { break }
            out.append(Data(b[at..<(at + n)]))
            at += n
        }
        return out
    }
}

/// A stroke being drawn: pen samples in, a preview per frame, a blob at the end.
public final class StrokeBuilder {
    private var ptr: OpaquePointer?
    public let tool: UInt8
    public let color: UInt32
    public let width: Float

    public init(tool: UInt8, color: UInt32, width: Float, z: String, flags: UInt8, created: Double = Date().timeIntervalSince1970 * 1000) {
        self.tool = tool
        self.color = color
        self.width = width
        ptr = z.withCString { nv_ink_builder_new(tool, color, width, $0, flags, created) }
    }

    deinit {
        if let p = ptr { nv_ink_builder_free(p) }
    }

    /// Page px, pressure 0...1, altitude/azimuth radians, time ms.
    public func push(x: Float, y: Float, pressure: Float, altitude: Float, azimuth: Float, t: Double) {
        guard let p = ptr else { return }
        nv_ink_builder_push(p, x, y, pressure, altitude, azimuth, t)
    }

    public var count: Int { ptr.map { nv_ink_builder_count($0) } ?? 0 }

    /// Triangles of the stroke so far plus predicted (x, y, pressure) samples.
    public func previewTriangles(predicted: [Float] = []) -> [Float] {
        guard let p = ptr else { return [] }
        return predicted.withUnsafeBufferPointer { InkEngine.floats(nv_ink_builder_preview_triangles(p, $0.baseAddress, predicted.count / 3)) }
    }

    /// The finished blob (nil without points). The builder is spent.
    public func finish() -> Data? {
        guard let p = ptr else { return nil }
        ptr = nil
        let d = InkEngine.bytes(nv_ink_builder_finish(p))
        return d.isEmpty ? nil : d
    }

    public func cancel() {
        if let p = ptr { nv_ink_builder_free(p) }
        ptr = nil
    }
}
