import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
import UniformTypeIdentifiers
#endif

// Export as Markdown (the page menu): the page as Markdown from the core (`pageMarkdown`: "# title", then the boxes in
// reading order, tasks as checklist lines), given to the share sheet (iPad, iPhone) or the save panel (Mac).

extension Shell {
    func exportMarkdown(_ session: SessionModel) {
        menu = nil
        guard !session.preview, let live = openLive, let snapshot = live.snapshot else {
            notYet("Export")
            return
        }
        FileExport.present(text: snapshot.markdown(), title: snapshot.title)
    }
}

extension Shell {
    /// Print the open page (the print sheet; the page colour too when `colour`).
    func printPage(_ session: SessionModel, colour: Bool = false) {
        menu = nil
        guard !session.preview, let live = openLive, let snapshot = live.snapshot else {
            notYet("Printing")
            return
        }
        if !PagePrinter.print(title: snapshot.title, colour: colour) { say("There is nothing to print yet.") }
    }

    /// Save the open page as a PDF (the share sheet on iPad and iPhone, the save panel on the Mac).
    func exportPDF(_ session: SessionModel) {
        menu = nil
        guard !session.preview, let live = openLive, let snapshot = live.snapshot else {
            notYet("Export")
            return
        }
        if !PagePrinter.savePDF(title: snapshot.title, colour: false) { say("There is nothing to export yet.") }
    }
}

enum FileExport {
    /// A file name from a page title: no slashes or other path characters, "Untitled" when empty.
    static func fileName(_ title: String, ext: String = "md") -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|\n\r")
        let cleaned = title.components(separatedBy: bad).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return (cleaned.isEmpty ? "Untitled" : String(cleaned.prefix(80))) + "." + ext
    }

    /// The server's suggested name, kept to one path component.
    static func safeName(_ name: String) -> String {
        let base = (name as NSString).lastPathComponent.replacingOccurrences(of: ":", with: " ").trimmingCharacters(in: .whitespaces)
        return base.isEmpty || base == "." || base == ".." ? "notivelo-data.zip" : base
    }

    #if canImport(UIKit)
    static func present(text: String, title: String) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(fileName(title))
        do { try text.write(to: url, atomically: true, encoding: .utf8) } catch { return }
        share(file: url)
    }

    /// A file the core made (a zip), under its own name: to the share sheet.
    static func save(data: Data, filename: String) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let url = dir.appendingPathComponent(safeName(filename))
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: url)
        } catch { return }
        share(file: url)
    }

    /// The front-most view controller (what a sheet is presented from).
    static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard var top = scene?.keyWindow?.rootViewController else { return nil }
        while let next = top.presentedViewController { top = next }
        return top
    }

    /// A file to the share sheet.
    static func share(file url: URL) {
        guard let top = topViewController() else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        // On the iPad the share sheet is a popover: anchor it in the middle of the screen.
        sheet.popoverPresentationController?.sourceView = top.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
        sheet.popoverPresentationController?.permittedArrowDirections = []
        top.present(sheet, animated: true)
    }
    #else
    static func present(text: String, title: String) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = fileName(title)
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            try? text.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    /// A file the core made (a zip), under its own name: the save panel.
    static func save(data: Data, filename: String) {
        let panel = NSSavePanel()
        let name = safeName(filename)
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = [UTType(filenameExtension: (name as NSString).pathExtension) ?? .data]
        panel.canCreateDirectories = true
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            try? data.write(to: url)
        }
    }
    #endif
}
