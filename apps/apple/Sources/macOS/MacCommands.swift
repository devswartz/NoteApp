import AppKit
import SwiftUI

/// The Mac's main menu (File, Edit, Format, View, Go, Window, Help) with the web's desktop shortcuts
/// (src/platform/tauri/shortcuts.ts, src/components/shell/commands.tsx). The window's shell is reached through
/// `ShellBridge`; editor commands go to the focused box (`EditorFocus`, which M6 part 2's box view registers with).
struct MacCommands: Commands {
    private var bridge: ShellBridge { .shared }
    private var focus: EditorFocus { .shared }

    var body: some Commands {
        // App > Settings
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { bridge.shell?.notYet("Settings") }.keyboardShortcut(",", modifiers: .command)
        }

        // File
        CommandGroup(replacing: .newItem) {
            Button("New Page") { bridge.newPage() }.keyboardShortcut("n", modifiers: .command)
            Button("New Section") { bridge.newSection() }.keyboardShortcut("n", modifiers: [.command, .shift])
            Button("New Notebook…") { bridge.newNotebook() }.keyboardShortcut("n", modifiers: [.command, .option])
            Button("New Task") { bridge.shell?.notYet("Adding tasks") }.keyboardShortcut("t", modifiers: [.command, .shift])
            Divider()
            Button("Share Page…") { bridge.sharePage() }
            Button("Version History…") { bridge.versionHistory() }
            Button("Trash…") { bridge.showTrash() }
            Button("Lock Pages Now") { bridge.lockPagesNow() }
            Divider()
            Button("Sign Out") { bridge.signOut() }
        }

        // Edit
        CommandGroup(replacing: .undoRedo) {
            Button("Undo") {
                if focus.active { focus.undo() } else { NSApp.sendAction(Selector(("undo:")), to: nil, from: nil) }
            }.keyboardShortcut("z", modifiers: .command)
            Button("Redo") {
                if focus.active { focus.redo() } else { NSApp.sendAction(Selector(("redo:")), to: nil, from: nil) }
            }.keyboardShortcut("z", modifiers: [.command, .shift])
        }
        CommandGroup(after: .textEditing) {
            // Find is the search palette over every page (the boxes have no find bar of their own yet).
            Button("Find…") { bridge.search() }.keyboardShortcut("f", modifiers: .command)
        }

        // Format
        CommandMenu("Format") {
            Button("Bold") { focus.run("toggleMark", ["mark": "bold"]) }.keyboardShortcut("b", modifiers: .command)
            Button("Italic") { focus.run("toggleMark", ["mark": "italic"]) }.keyboardShortcut("i", modifiers: .command)
            Button("Underline") { focus.run("toggleMark", ["mark": "underline"]) }.keyboardShortcut("u", modifiers: .command)
            Button("Strikethrough") { focus.run("toggleMark", ["mark": "strike"]) }.keyboardShortcut("x", modifiers: [.command, .shift])
            Divider()
            Button("Normal Text") { focus.run("setParagraph") }.keyboardShortcut("0", modifiers: [.command, .option])
            Button("Heading 1") { focus.run("setHeading", ["level": 1]) }.keyboardShortcut("1", modifiers: [.command, .option])
            Button("Heading 2") { focus.run("setHeading", ["level": 2]) }.keyboardShortcut("2", modifiers: [.command, .option])
            Button("Heading 3") { focus.run("setHeading", ["level": 3]) }.keyboardShortcut("3", modifiers: [.command, .option])
            Button("Quote") { focus.run("toggleQuote") }
            Button("Code Block") { focus.run("toggleCodeBlock") }.keyboardShortcut("c", modifiers: [.command, .option])
            Divider()
            Button("Bulleted List") { focus.run("toggleBulletList") }
            Button("Numbered List") { focus.run("toggleOrderedList") }
            Button("Indent") { focus.run("indent") }.keyboardShortcut("]", modifiers: .command)
            Button("Outdent") { focus.run("outdent") }.keyboardShortcut("[", modifiers: .command)
            Button("Turn into Task") { focus.run("convertToTask") }
            Divider()
            // As the web: Cmd-K is Link while a box is being edited, else the search.
            Button("Link…") {
                if focus.active { focus.openLinkEditor() } else { bridge.search() }
            }.keyboardShortcut("k", modifiers: .command)
        }

        // View
        CommandGroup(replacing: .sidebar) {
            Button("Toggle Sidebar") { bridge.toggleSidebar() }.keyboardShortcut("s", modifiers: [.command, .control])
            Button("Toggle Ribbon") { bridge.toggleRibbon() }.keyboardShortcut("r", modifiers: [.command, .option])
            Divider()
            Button("Zoom In") { bridge.zoom(by: 1.1) }.keyboardShortcut("+", modifiers: .command)
            Button("Zoom Out") { bridge.zoom(by: 1 / 1.1) }.keyboardShortcut("-", modifiers: .command)
            Button("Actual Size") { bridge.zoomActual() }.keyboardShortcut("0", modifiers: .command)
            Divider()
            Menu("Theme") {
                ForEach(ThemeMode.allCases, id: \.self) { mode in
                    Toggle(mode.label, isOn: Binding(get: { Theme.shared.mode == mode }, set: { if $0 { Theme.shared.mode = mode } }))
                }
            }
        }

        // Go
        CommandMenu("Go") {
            Button("Notes") { bridge.showNotes() }.keyboardShortcut("8", modifiers: .command)
            Button("Today") { bridge.showTasks(.today) }.keyboardShortcut("1", modifiers: .command)
            Button("Upcoming") { bridge.showTasks(.upcoming) }.keyboardShortcut("2", modifiers: .command)
            Button("My Tasks") { bridge.showTasks(.my) }.keyboardShortcut("3", modifiers: .command)
            Button("All Tasks") { bridge.showTasks(.all) }.keyboardShortcut("5", modifiers: .command)
            Button("Calendar") { bridge.showCalendar() }.keyboardShortcut("6", modifiers: .command)
            Divider()
            Button("Search…") { bridge.search() }.keyboardShortcut("f", modifiers: [.command, .shift])
        }

        // Help
        CommandGroup(replacing: .help) {
            Button("Notivelo Help") {
                if let url = URL(string: SessionModel.production + "/support") { NSWorkspace.shared.open(url) }
            }
            Button("Keyboard Shortcuts") { bridge.shell?.notYet("The shortcuts list") }.keyboardShortcut("/", modifiers: .command)
        }
    }
}
