import Foundation
import ImageIO
import CoreGraphics
import CryptoKit
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// The pictures of image nodes: loaded once per stored address (`/uploads/<id>.png`, or an external https link), kept in
/// memory and, for uploads (they never change), on disk in the Caches folder. `state(_:)` answers at once for the renderer:
/// the picture, "still loading" or "can't be shown" (offline, gone, not a picture); a finished load posts `loaded` so the
/// boxes showing it draw again.
final class MediaCache {
    static let shared = MediaCache()
    /// Posted on the main thread when a picture arrived or failed; `userInfo["src"]` is its address.
    static let loaded = Notification.Name("nvMediaLoaded")

    enum State {
        case loading
        case failed
        /// The picture (at most 2400 px a side) and the original's size in pixels.
        case ready(PlatformImage, natural: CGSize)
    }

    private final class Entry {
        let image: PlatformImage
        let natural: CGSize
        init(_ image: PlatformImage, _ natural: CGSize) {
            self.image = image
            self.natural = natural
        }
    }

    /// How the app gets a stored file's bytes: set by the shell to the core's `downloadFile` (nil until signed in).
    var fetch: ((String, @escaping (Result<Data, Error>) -> Void) -> Void)?

    private let memory = NSCache<NSString, Entry>()
    private var pending = Set<String>()
    private var failedAt: [String: Date] = [:]
    private let queue = DispatchQueue(label: "notivelo.media", qos: .userInitiated)

    private init() {
        memory.countLimit = 80
    }

    /// Corpus mode (CI screenshots, no network): `look-sample.png` is a picture drawn in code, anything else "can't be shown".
    private static var preview: Bool { UserDefaults.standard.bool(forKey: "previewSignedIn") }

    func state(_ src: String) -> State {
        if Self.preview {
            guard src.contains("look-sample"), let e = Self.sample else { return .failed }
            return .ready(e.image, natural: e.natural)
        }
        if let e = memory.object(forKey: src as NSString) { return .ready(e.image, natural: e.natural) }
        if pending.contains(src) { return .loading }
        if let t = failedAt[src] {
            if Date().timeIntervalSince(t) < 20 { return .failed }
            failedAt[src] = nil
        }
        start(src)
        return .loading
    }

    /// A picture the app already has (just uploaded): shown without fetching it back.
    func store(_ src: String, _ data: Data) {
        guard !Self.preview else { return }
        pending.insert(src)
        finish(src, data, save: true)
    }

    /// Forget a failure (the person tapped the placeholder, or the connection is back): the next draw tries again.
    func retry(_ src: String) { failedAt[src] = nil }

    /// Forget every picture, in memory and on disk (the account was deleted).
    func clearAll() {
        memory.removeAllObjects()
        pending.removeAll()
        failedAt.removeAll()
        queue.async { if let dir = Self.folder { try? FileManager.default.removeItem(at: dir) } }
    }

    private func start(_ src: String) {
        pending.insert(src)
        queue.async { [weak self] in
            if let data = Self.diskRead(src) {
                self?.finish(src, data, save: false)
                return
            }
            DispatchQueue.main.async { self?.download(src) }
        }
    }

    private func download(_ src: String) {
        if src.hasPrefix("https://") || src.hasPrefix("http://") {
            guard let url = URL(string: src) else { return fail(src) }
            URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
                let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
                if let data, ok { self?.finish(src, data, save: false) } else { DispatchQueue.main.async { self?.fail(src) } }
            }.resume()
            return
        }
        guard let fetch else { return fail(src) }
        fetch(src) { [weak self] result in
            if case let .success(data) = result { self?.finish(src, data, save: true) } else { self?.fail(src) }
        }
    }

    /// Decode off the main thread, then keep and announce it.
    private func finish(_ src: String, _ data: Data, save: Bool) {
        queue.async { [weak self] in
            guard let decoded = Self.decode(data) else {
                DispatchQueue.main.async { self?.fail(src) }
                return
            }
            if save { Self.diskWrite(src, data) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.memory.setObject(Entry(decoded.image, decoded.natural), forKey: src as NSString)
                self.pending.remove(src)
                self.failedAt[src] = nil
                NotificationCenter.default.post(name: Self.loaded, object: nil, userInfo: ["src": src])
            }
        }
    }

    private func fail(_ src: String) {
        pending.remove(src)
        failedAt[src] = Date()
        NotificationCenter.default.post(name: Self.loaded, object: nil, userInfo: ["src": src])
    }

    // MARK: Decoding

    private static func decode(_ data: Data) -> (image: PlatformImage, natural: CGSize)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        var w = (props?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
        var h = (props?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
        let orientation = (props?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        if orientation >= 5 { swap(&w, &h) }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: 2400,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        if w <= 0 || h <= 0 {
            w = Double(cg.width)
            h = Double(cg.height)
        }
        return (MediaCache.platformImage(cg), CGSize(width: w, height: h))
    }

    private static func platformImage(_ cg: CGImage) -> PlatformImage {
        #if canImport(UIKit)
        return UIImage(cgImage: cg, scale: 1, orientation: .up)
        #else
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
        #endif
    }

    // MARK: Disk

    private static var folder: URL? {
        guard let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let dir = base.appendingPathComponent("NotiveloMedia", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func file(_ src: String) -> URL? {
        guard src.hasPrefix("/uploads/") else { return nil }
        let name = SHA256.hash(data: Data(src.utf8)).map { String(format: "%02x", $0) }.joined()
        return folder?.appendingPathComponent(name)
    }

    private static func diskRead(_ src: String) -> Data? {
        file(src).flatMap { try? Data(contentsOf: $0) }
    }

    private static func diskWrite(_ src: String, _ data: Data) {
        if let url = file(src) { try? data.write(to: url, options: .atomic) }
    }

    // MARK: Corpus sample

    /// A picture drawn in code for the look states: sky, sun and two hills, 800 × 480.
    private static let sample: (image: PlatformImage, natural: CGSize)? = {
        let w = 800, h = 480
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let sky = CGGradient(colorsSpace: space, colors: [CGColor(red: 0.99, green: 0.84, blue: 0.62, alpha: 1), CGColor(red: 0.36, green: 0.55, blue: 0.86, alpha: 1)] as CFArray,
                             locations: [0, 1])!
        ctx.drawLinearGradient(sky, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: CGFloat(h)), options: [])
        ctx.setFillColor(CGColor(red: 1, green: 0.95, blue: 0.75, alpha: 1))
        ctx.fillEllipse(in: CGRect(x: 520, y: 270, width: 110, height: 110))
        ctx.setFillColor(CGColor(red: 0.30, green: 0.52, blue: 0.40, alpha: 1))
        ctx.fillEllipse(in: CGRect(x: -150, y: -330, width: 800, height: 520))
        ctx.setFillColor(CGColor(red: 0.18, green: 0.38, blue: 0.32, alpha: 1))
        ctx.fillEllipse(in: CGRect(x: 280, y: -380, width: 840, height: 520))
        guard let cg = ctx.makeImage() else { return nil }
        return (MediaCache.platformImage(cg), CGSize(width: w, height: h))
    }()
}
