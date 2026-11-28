import Foundation
import NotiveloCore

// The page's colour and rule lines (the ribbon's Page group): written into the open live page with
// `LivePage.setPageSettings`, which goes out like any edit. Not undoable, as on the web. The canvas and the
// page's tint redraw from the page's own change (`LivePageModel.info`), so the others' changes show too.

extension Shell {
    /// What the open page has now (nil while none is open live: the corpus preview).
    var pageSettings: PageSettings? { openLive?.info?.settings }

    func setPageSettings(color: String? = nil, rules: String? = nil, what: String) {
        menu = nil
        guard let live = openLive else {
            notYet(what)
            return
        }
        live.boxCall({ _ = try $0.setPageSettings(color: color, rules: rules) }) { [weak self] error in
            if let error { self?.say(CoreBridge.message(error)) }
        }
    }
}
