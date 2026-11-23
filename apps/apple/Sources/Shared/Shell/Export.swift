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

enum FileExport {
    /// A file name from a page title: no slashes or other path characters, "Untitled" when empty.
    static func fileName(_ title: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|\n\r")
        let cleaned = title.components(separatedBy: bad).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        return (cleaned.isEmpty ? "Untitled" : String(cleaned.prefix(80))) + ".md"
    }

    #if canImport(UIKit)
    static func present(text: String, title: String) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(fileName(title))
        do { try text.write(to: url, atomically: true, encoding: .utf8) } catch { return }
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard var top = scene?.keyWindow?.rootViewController else { return }
        while let next = top.presentedViewController { top = next }
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
    #endif
}
