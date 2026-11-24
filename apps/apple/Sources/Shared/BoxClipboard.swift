import Foundation
import NotiveloCore
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Copy, cut, paste, duplicate and delete of whole boxes (the web's `boxClipboard.ts`): the core builds and reads the clip
/// (`LivePage.boxesJson`, `pasteBoxes`, `duplicateBoxes`, `deleteBoxWithContent`); each call is one undo step of the page.
/// The clip goes on the system pasteboard under `type` (its JSON) with the boxes' plain text beside it for other apps.
/// A copy keeps the same tasks as the original (a cut one moves them), where the web makes copies of them.
enum BoxClipboard {
    static let type = "com.notivelo.boxes"

    static func write(_ json: String) {
        var text = ""
        if let data = json.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            text = o["text"] as? String ?? ""
        }
        #if canImport(UIKit)
        UIPasteboard.general.setItems([[type: Data(json.utf8), "public.utf8-plain-text": text]])
        #else
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.declareTypes([NSPasteboard.PasteboardType(type), .string], owner: nil)
        pb.setData(Data(json.utf8), forType: NSPasteboard.PasteboardType(type))
        pb.setString(text, forType: .string)
        #endif
    }

    static func read() -> String? {
        #if canImport(UIKit)
        return UIPasteboard.general.data(forPasteboardType: type).flatMap { String(data: $0, encoding: .utf8) }
        #else
        return NSPasteboard.general.data(forType: NSPasteboard.PasteboardType(type)).flatMap { String(data: $0, encoding: .utf8) }
        #endif
    }

    static var canPaste: Bool {
        #if canImport(UIKit)
        return UIPasteboard.general.contains(pasteboardTypes: [type])
        #else
        return NSPasteboard.general.types?.contains(NSPasteboard.PasteboardType(type)) == true
        #endif
    }
}

/// The box actions on a live page. `done` runs on the main thread: nil on success, else what to tell the person.
enum BoxActions {
    static func copy(_ ids: [String], host: PageEditHost, _ done: @escaping (String?) -> Void) {
        var json = ""
        host.boxCall({ live in json = try live.boxesJson(boxIds: ids) }) { err in
            if err == nil { BoxClipboard.write(json) }
            done(err.map { _ in "Couldn’t copy" })
        }
    }

    static func cut(_ ids: [String], host: PageEditHost, _ done: @escaping (String?) -> Void) {
        var json = ""
        host.boxCall({ live in
            json = try live.boxesJson(boxIds: ids)
            for id in ids { try live.deleteBoxWithContent(id: id) }
        }) { err in
            if err == nil { BoxClipboard.write(json) }
            done(err.map { _ in "Couldn’t cut" })
        }
    }

    static func delete(_ ids: [String], host: PageEditHost, _ done: @escaping (String?) -> Void) {
        host.boxCall({ live in for id in ids { try live.deleteBoxWithContent(id: id) } }) { err in
            done(err.map { _ in "Couldn’t delete" })
        }
    }

    /// Paste what `copy` or `cut` put on the pasteboard: the new boxes' ids, at (x, y) when given (page points), else nudged
    /// from where they were.
    static func paste(host: PageEditHost, at point: CGPoint? = nil, _ done: @escaping ([String], String?) -> Void) {
        guard let json = BoxClipboard.read() else { done([], nil); return }
        var ids: [String] = []
        host.boxCall({ live in
            ids = try live.pasteBoxes(json: json, atX: point.map { Double($0.x) }, atY: point.map { Double($0.y) }, taskMap: [:])
        }) { err in
            done(ids, err.map { _ in "Couldn’t paste" })
        }
    }

    static func duplicate(_ ids: [String], host: PageEditHost, _ done: @escaping ([String], String?) -> Void) {
        var out: [String] = []
        host.boxCall({ live in out = try live.duplicateBoxes(boxIds: ids) }) { err in
            done(out, err.map { _ in "Couldn’t duplicate" })
        }
    }
}
