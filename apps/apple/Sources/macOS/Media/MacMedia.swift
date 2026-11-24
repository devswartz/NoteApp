import AppKit
import UniformTypeIdentifiers

/// The Mac side of images and attachments: the open panel, what a paste or a drop carries, and opening a downloaded file.
/// The app is sandboxed: the open panel (`files.user-selected.read-write`) and dropped files give access to what was chosen.
enum PlatformMedia {
    /// Ask for pictures or files; `done` gets what was chosen (nothing if cancelled) on the main thread.
    static func pick(_ kind: MediaKind, done: @escaping ([PickedFile]) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.prompt = kind == .image ? "Insert" : "Attach"
        panel.message = kind == .image ? "Choose pictures to put on the page" : "Choose files to attach to the page"
        if kind == .image { panel.allowedContentTypes = [.image] }
        let finish: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .OK else { return }
            let urls = panel.urls
            DispatchQueue.global(qos: .userInitiated).async {
                let items = read(urls)
                DispatchQueue.main.async { if !items.isEmpty { done(items) } }
            }
        }
        if let window = NSApp.keyWindow { panel.beginSheetModal(for: window, completionHandler: finish) } else { panel.begin(completionHandler: finish) }
    }

    /// Open a downloaded file in the app the Mac prefers for it (an address opens in the browser).
    static func open(_ url: URL) { NSWorkspace.shared.open(url) }

    private static func read(_ urls: [URL]) -> [PickedFile] {
        urls.compactMap { url in
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return nil }
            return PickedFile(data: data, filename: url.lastPathComponent)
        }
    }

    // MARK: Pasteboard (paste and drop)

    private static func fileURLs(_ board: NSPasteboard) -> [URL] {
        let found = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return found.filter { url in
            var isDirectory: ObjCBool = false
            return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && !isDirectory.boolValue
        }
    }

    private static func imageData(_ board: NSPasteboard) -> (data: Data, type: String)? {
        if let png = board.data(forType: .png) { return (png, "png") }
        if let tiff = board.data(forType: .tiff), let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) { return (png, "png") }
        return nil
    }

    /// The pasteboard carries files (copied in Finder, dragged in) or a picture.
    static func hasMedia(_ board: NSPasteboard) -> Bool {
        !fileURLs(board).isEmpty || imageData(board) != nil
    }

    /// Files on the pasteboard (copied or dragged in Finder), else a picture's data (a screenshot, a copied image).
    static func pasteboardFiles(_ board: NSPasteboard) -> [PickedFile] {
        let urls = fileURLs(board)
        if !urls.isEmpty { return read(urls) }
        if let image = imageData(board) { return [PickedFile(data: image.data, filename: MediaPrep.name(forImageType: image.type))] }
        return []
    }

    /// Copied files (the file names are on the pasteboard as text too: a paste of files isn't a paste of their names).
    static func hasFiles(_ board: NSPasteboard) -> Bool { !fileURLs(board).isEmpty }
}
