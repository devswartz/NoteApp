import Foundation
import ImageIO
import NotiveloCore
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#endif

/// A file the person chose, pasted or dropped, ready to upload.
struct PickedFile {
    var data: Data
    var filename: String
}

enum MediaKind { case image, file }

/// Images and attachments in the editor (src/editor/upload.ts, `insertFiles` in NoteEditor.tsx): upload a picked, pasted or dropped
/// file to the page's workspace, then insert an image block (a picture the web can draw) or a file card at the caret; open a file
/// card's file or an image full size. Everything that talks to the core runs through `SessionModel.call` (off the main thread).
/// The platform parts (the pickers, the preview window) are `PlatformMedia`, in the iOS and macOS folders.
final class MediaHub {
    static let shared = MediaHub()

    weak var session: SessionModel?
    weak var shell: Shell?
    /// The page being shown (uploads are tied to it).
    var pageId: String?

    private init() {}

    /// The shell shows a page: tell the hub which page and session, and let pictures load through the core.
    func configure(session: SessionModel, shell: Shell, pageId: String) {
        self.session = session
        self.shell = shell
        self.pageId = pageId
        MediaCache.shared.fetch = { [weak session] src, done in
            guard let session else {
                done(.failure(CancellationError()))
                return
            }
            session.call({ try $0.downloadFile(url: src).bytes }, then: done)
        }
    }

    // MARK: Insert

    /// Ask for a picture or a file (the slash menu's Image and File attachment, the ribbon's Insert group), then upload and insert it.
    func pick(_ kind: MediaKind, into target: EditorTarget?) {
        guard let target else { return }
        if session?.preview == true {
            shell?.notYet(kind == .image ? "Images" : "File attachments")
            return
        }
        PlatformMedia.pick(kind) { [weak self] items in self?.upload(items, into: target) }
    }

    /// Upload each file in turn and insert it at the caret of `target`, as the web's `insertFiles` does.
    func upload(_ items: [PickedFile], into target: EditorTarget) {
        guard !items.isEmpty else { return }
        guard let session, !session.preview else {
            shell?.say("Uploads aren’t available in the preview.")
            return
        }
        guard let workspaceId = session.workspaceId else { return }
        let pageId = self.pageId
        let total = items.count
        var rest = items
        func next() {
            guard !rest.isEmpty else { return }
            let item = rest.removeFirst()
            shell?.say(total > 1 ? "Uploading \(total - rest.count) of \(total)…" : "Uploading…")
            session.call({ core -> (UploadedFile, Data) in
                let ready = MediaPrep.prepare(item)
                return (try core.uploadFile(workspaceId: workspaceId, pageId: pageId, filename: ready.filename, data: ready.data), ready.data)
            }, then: { [weak self] result in
                switch result {
                case let .success((file, data)):
                    self?.insert(file, data: data, into: target)
                    next()
                case let .failure(error):
                    if !(error is CancellationError) { self?.shell?.say(Self.uploadMessage(error)) }
                }
            })
        }
        next()
    }

    private func insert(_ file: UploadedFile, data: Data, into target: EditorTarget) {
        shell?.toast = nil
        shell?.toastAction = nil
        #if canImport(UIKit)
        _ = (target as? UIResponder)?.becomeFirstResponder()
        #endif
        let mime = file.mime.lowercased()
        // The web: an image node for image types, except HEIC (browsers can't draw it); anything else a file card.
        let isImage = mime.hasPrefix("image/") && mime != "image/heic" && mime != "image/heif" && !mime.contains("svg")
        let args: [String: Any] = isImage
            ? ["src": file.url, "alt": file.name]
            : ["url": file.url, "name": file.name, "size": NSNumber(value: file.size), "mime": file.mime]
        let json = (try? JSONSerialization.data(withJSONObject: args)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        // The picture is in hand: the box draws it at once, without fetching it back.
        if isImage { MediaCache.shared.store(file.url, data) }
        if !target.command(isImage ? "insertImage" : "insertFile", json) {
            shell?.say("Couldn’t add \(isImage ? "the image" : "the file") to the page.")
        }
    }

    static func uploadMessage(_ error: Error) -> String {
        switch error as? CoreError {
        case .Network(_)?: return "You're offline. Nothing was uploaded."
        case let .Server(_, message, _)?: return message.isEmpty ? "Couldn’t upload the file." : message
        case .SignedOut?: return CoreBridge.message(error)
        default: return "Couldn’t upload the file."
        }
    }

    // MARK: Open

    /// What a tap or double click on an image or file card opens.
    func open(_ m: BoxMedia) {
        if m.kind == .file { openFile(url: m.src, name: m.name) } else { openImage(src: m.src, name: m.name) }
    }

    /// A file card tapped: download the file and open it (iOS: Quick Look, which shares; Mac: the default app).
    func openFile(url: String, name: String) {
        guard !url.isEmpty else { return }
        guard let session, !session.preview else {
            shell?.say("Opening files isn’t available in the preview.")
            return
        }
        shell?.say("Opening…")
        session.call({ try $0.downloadFile(url: url) }, then: { [weak self] result in
            switch result {
            case let .success(file):
                self?.shell?.toast = nil
                if let tmp = MediaFiles.write(file.bytes, name: name, mime: file.mime) { PlatformMedia.open(tmp) }
            case let .failure(error):
                if !(error is CancellationError) { self?.shell?.say(Self.openMessage(error)) }
            }
        })
    }

    /// An image opened full size (a double tap or double click).
    func openImage(src: String, name: String) {
        if let u = URL(string: src), u.scheme == "https" || u.scheme == "http" {
            PlatformMedia.open(u)
            return
        }
        guard !src.isEmpty else { return }
        openFile(url: src, name: name.isEmpty ? "Image" : name)
    }

    static func openMessage(_ error: Error) -> String {
        switch error as? CoreError {
        case .Network(_)?: return "You're offline. The file can't be opened."
        case let .Server(status, message, _)?: return status == 404 ? "That file is gone." : (message.isEmpty ? "Couldn’t open the file." : message)
        default: return "Couldn’t open the file."
        }
    }
}

/// Temporary files for opening what was downloaded.
enum MediaFiles {
    /// `data` in a new temporary folder under a safe file name that has an extension (taken from `mime` when the name has none).
    static func write(_ data: Data, name: String, mime: String) -> URL? {
        var clean = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-").trimmingCharacters(in: .whitespaces)
        if clean.isEmpty { clean = "file" }
        if (clean as NSString).pathExtension.isEmpty, let ext = UTType(mimeType: mime)?.preferredFilenameExtension { clean += "." + ext }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("NotiveloOpen", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(clean)
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }
}

enum MediaPrep {
    /// HEIC photos go up as JPEG (the web can't draw HEIC, and the server stores it as a plain file).
    static func prepare(_ item: PickedFile) -> PickedFile {
        let ext = (item.filename as NSString).pathExtension.lowercased()
        let out = NSMutableData()
        guard ext == "heic" || ext == "heif", let source = CGImageSourceCreateWithData(item.data as CFData, nil),
              let dest = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else { return item }
        CGImageDestinationAddImageFromSource(dest, source, 0, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return item }
        let base = (item.filename as NSString).deletingPathExtension
        return PickedFile(data: out as Data, filename: (base.isEmpty ? "Photo" : base) + ".jpg")
    }

    /// Image bytes with no name (a pasted screenshot, a dropped picture): a name from the time, by type.
    static func name(forImageType type: String) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        return "Image \(f.string(from: Date())).\(type)"
    }
}
