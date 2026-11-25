import AppKit
import Carbon.HIToolbox

/// The Mac app's menu bar icon (Quick Capture, Open Notivelo, Quit) and the global quick-capture shortcut, as today's desktop
/// app has them (apps/desktop quick.rs: Option-Command-N). The app keeps running when its last window closes, so both still
/// work; a click on the Dock icon, or Open Notivelo, brings the window back. The shortcut is a Carbon hot key
/// (`RegisterEventHotKey`): it needs no Accessibility permission and works inside the App Sandbox.
final class MacAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // The CI screenshots (corpus preview) have no menu bar icon or global shortcut.
        guard !UserDefaults.standard.bool(forKey: "previewSignedIn") else { return }
        MacMenuBar.shared.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { true }
}

final class MacMenuBar: NSObject {
    static let shared = MacMenuBar()
    private var item: NSStatusItem?
    private var hotKey: EventHotKeyRef?
    private var started = false

    private var due = 0
    private var dueItem: NSMenuItem?

    /// The tasks due today or overdue: the count beside the icon, and a line in the menu (tray.rs shows the same).
    func setDue(_ n: Int) {
        due = n
        apply()
    }

    private func apply() {
        guard let item else { return }
        if let button = item.button {
            button.imagePosition = .imageLeft
            button.title = due > 0 ? " \(due)" : ""
        }
        dueItem?.title = due == 0 ? "Nothing due today" : due == 1 ? "1 task due today" : "\(due) tasks due today"
    }

    func start() {
        guard !started else { return }
        started = true
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = item.button {
            let image = NSImage(systemSymbolName: "note.text", accessibilityDescription: "Notivelo")
            image?.isTemplate = true
            button.image = image
            button.toolTip = "Notivelo"
        }
        let menu = NSMenu()
        let dueLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        dueLine.isEnabled = false
        menu.addItem(dueLine)
        dueItem = dueLine
        menu.addItem(.separator())
        let quick = NSMenuItem(title: "Quick Capture…", action: #selector(quickCapture), keyEquivalent: "n")
        quick.keyEquivalentModifierMask = [.option, .command]
        quick.target = self
        menu.addItem(quick)
        let open = NSMenuItem(title: "Open Notivelo", action: #selector(openApp), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Notivelo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quit.keyEquivalentModifierMask = [.command]
        menu.addItem(quit)
        item.menu = menu
        self.item = item
        apply()
        registerHotKey()
    }

    /// Option-Command-N from any app.
    private func registerHotKey() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { MacMenuBar.shared.quickCapture() }
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x4E56_5451), id: 1)
        RegisterEventHotKey(UInt32(kVK_ANSI_N), UInt32(optionKey | cmdKey), id, GetApplicationEventTarget(), 0, &hotKey)
    }

    /// The quick add dialog over the app's window (made again first when every window was closed).
    @objc func quickCapture() {
        bringForward()
        ShellBridge.shared.quickCapture()
    }

    @objc func openApp() { bringForward() }

    private func bringForward() {
        NSApp.activate(ignoringOtherApps: true)
        if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
            window.makeKeyAndOrderFront(nil)
        } else {
            // No window left: opening the running app again makes the Dock "reopen" that brings one back.
            NSWorkspace.shared.open(Bundle.main.bundleURL)
        }
    }
}
