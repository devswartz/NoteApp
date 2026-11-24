import Foundation
import NotiveloCore
import SwiftUI

// Page templates (src/editor/TemplatePicker.tsx, defaultTemplates.ts, templates.ts): the built-in three, the workspace's saved
// ones (core: templates, useTemplate, savePageAsTemplate, updateTemplate, deleteTemplate), a default per section, and a new page
// from a template. The server never writes page content: the template's content goes into the open page through
// `LivePage.insertTemplateContent` (one undoable edit).

// MARK: Built-in templates

private typealias TBox = (x: Double, y: Double, w: Double, content: [[String: Any]])

/// A built-in template (the web's `TEMPLATES`): its canvas version as the editor JSON the core inserts.
struct BuiltinTemplate: Identifiable {
    let id: String
    let name: String
    let description: String
    let icon: String
    let title: (Date) -> String
    fileprivate let boxes: (Date) -> [TBox]

    func contentJson(_ now: Date = Date()) -> String {
        let nodes: [[String: Any]] = boxes(now).enumerated().map { i, b in
            ["type": "canvasBox", "attrs": ["x": b.x, "y": b.y, "w": b.w, "z": i + 1] as [String: Any], "content": b.content]
        }
        let doc: [String: Any] = ["type": "doc", "content": nodes]
        let data = (try? JSONSerialization.data(withJSONObject: doc)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    static func longDate(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateStyle = .full
        f.timeStyle = .none
        return f.string(from: d)
    }

    static func shortDate(_ d: Date) -> String {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        return f.string(from: d)
    }

    static let all: [BuiltinTemplate] = [
        BuiltinTemplate(id: "meeting", name: "Meeting notes", description: "Attendees, agenda, notes and action items", icon: "🤝",
                        title: { "Meeting · \(shortDate($0))" }, boxes: { d in
            [box(0, 0, 340, p(t("Date: ", ["bold"]), t(longDate(d))), h(3, "Attendees"), bullets(""), h(3, "Agenda"), numbered("")),
             box(380, 0, 460, h(3, "Notes"), p(), h(3, "Decisions"), bullets("")),
             box(0, 360, 840, h(3, "Action items"),
                            callout("✅", p(t("Type "), t("/task", ["code"]), t(" for a task. Action items land on everyone’s dashboard."))), p())]
        }),
        BuiltinTemplate(id: "project", name: "Project", description: "Goal, scope, milestones and open questions", icon: "🎯",
                        title: { _ in "New project" }, boxes: { _ in
            [box(0, 0, 840, callout("🎯", p(t("Goal: ", ["bold"]), t("what does success look like?"))), muted("Why are we doing this, and for whom?")),
             box(0, 180, 400, h(3, "Scope"), table([["In scope", "Out of scope"], ["", ""]])),
             box(440, 180, 400, h(3, "Milestones"), table([["Milestone", "Target date"], ["", ""], ["", ""]])),
             box(0, 480, 400, h(3, "Tasks"), muted("Type /task to add a task: “Draft spec friday p2 @sam”."), p()),
             box(440, 480, 400, h(3, "Open questions"), bullets(""), h(3, "Links"), bullets(""))]
        }),
        BuiltinTemplate(id: "journal", name: "Daily journal", description: "Focus, notes and a short review", icon: "📓",
                        title: { longDate($0) }, boxes: { _ in
            [box(0, 0, 320, h(3, "Top 3 today"), checklist("", "", "")),
             box(360, 0, 480, h(3, "Notes"), p()),
             box(0, 240, 320, h(3, "Grateful for"), bullets("")),
             box(0, 440, 320, toggle("End-of-day review", p(t("What went well? What would I change?", ["italic"]))))]
        }),
    ]

    private static func box(_ x: Double, _ y: Double, _ w: Double, _ content: [String: Any]...) -> TBox { (x, y, w, content) }

    // The editor's node shapes (ProseMirror JSON).
    private static func t(_ s: String, _ marks: [String] = []) -> [String: Any] {
        var o: [String: Any] = ["type": "text", "text": s]
        if !marks.isEmpty { o["marks"] = marks.map { ["type": $0] } }
        return o
    }
    private static func p(_ c: [String: Any]...) -> [String: Any] {
        c.isEmpty ? ["type": "paragraph"] : ["type": "paragraph", "content": c]
    }
    private static func h(_ level: Int, _ s: String) -> [String: Any] {
        ["type": "heading", "attrs": ["level": level], "content": [t(s)]]
    }
    private static func item(_ kind: String, _ s: String, attrs: [String: Any]? = nil) -> [String: Any] {
        var o: [String: Any] = ["type": kind, "content": [s.isEmpty ? p() : p(t(s))]]
        if let attrs { o["attrs"] = attrs }
        return o
    }
    private static func bullets(_ items: String...) -> [String: Any] {
        ["type": "bulletList", "content": items.map { item("listItem", $0) }]
    }
    private static func numbered(_ items: String...) -> [String: Any] {
        ["type": "orderedList", "content": items.map { item("listItem", $0) }]
    }
    private static func checklist(_ items: String...) -> [String: Any] {
        ["type": "taskList", "content": items.map { item("taskItem", $0, attrs: ["checked": false]) }]
    }
    private static func callout(_ emoji: String, _ c: [String: Any]...) -> [String: Any] {
        ["type": "callout", "attrs": ["emoji": emoji], "content": c]
    }
    private static func table(_ rows: [[String]]) -> [String: Any] {
        var out: [[String: Any]] = []
        for (i, r) in rows.enumerated() {
            let cells: [[String: Any]] = r.map { c in
                ["type": i == 0 ? "tableHeader" : "tableCell", "content": [c.isEmpty ? p() : p(t(c))]]
            }
            out.append(["type": "tableRow", "content": cells])
        }
        return ["type": "table", "content": out]
    }
    private static func toggle(_ summary: String, _ c: [String: Any]...) -> [String: Any] {
        let head: [String: Any] = ["type": "detailsSummary", "content": [t(summary)]]
        let body: [String: Any] = ["type": "detailsContent", "content": c.isEmpty ? [p()] : c]
        return ["type": "details", "content": [head, body]]
    }
    private static func muted(_ s: String) -> [String: Any] { p(t(s, ["italic"])) }
}

// MARK: Model

/// Where a template is offered for a section (the web's `templateOffer`).
enum TemplateOffer { case section, everywhere }

@Observable
final class TemplatesModel {
    static let shared = TemplatesModel()

    enum Pending { case builtin(String), claim }

    var items: [TemplateInfo] = []
    var defaults: [SectionDefaultTemplate] = []
    var busy = false
    /// A page just made from a template (or a section default) waits here for its page to open and sync (PageScreen runs `consume`).
    @ObservationIgnored var pending: [String: Pending] = [:]

    func load(_ session: SessionModel) {
        if session.preview {
            if LookData.state == "templates" { items = Self.lookItems }
            return
        }
        guard let ws = session.workspaceId else { return }
        session.call({ core -> ([TemplateInfo], [SectionDefaultTemplate]) in
            (try core.templates(workspaceId: ws), (try? core.sectionDefaultTemplates(workspaceId: ws)) ?? [])
        }) { r in
            if case let .success((t, d)) = r {
                self.items = t
                self.defaults = d
            }
        }
    }

    private static var lookItems: [TemplateInfo] {
        [TemplateInfo(id: "t1", workspaceId: "w", name: "Weekly review", icon: "🗓️", visibility: "workspace", kind: "canvas", createdBy: "demo",
                      createdAt: "", updatedAt: "", taskCount: 2, fileCount: 0, canManage: true, scoped: false, sections: []),
         TemplateInfo(id: "t2", workspaceId: "w", name: "1:1 notes", icon: "💬", visibility: "private", kind: "canvas", createdBy: "demo",
                      createdAt: "", updatedAt: "", taskCount: 0, fileCount: 0, canManage: true, scoped: false, sections: [])]
    }

    /// Whether (and how) a saved template is offered in a section: tied to it (or a parent it covers), everywhere, or not here.
    static func offer(_ t: TemplateInfo, section: String?, tree: Tree?) -> TemplateOffer? {
        if !t.scoped { return .everywhere }
        guard let section, let tree else { return nil }
        var current: String? = section
        var first = true
        while let id = current, let s = tree.sections.first(where: { $0.id == id }) {
            if let scope = t.sections.first(where: { $0.sectionId == s.id }), first || scope.includeSubsections { return .section }
            current = s.parentId
            first = false
        }
        return nil
    }

    private static func nowStrings() -> (String, String) {
        let now = Date()
        let time = DateFormatter()
        time.dateStyle = .none
        time.timeStyle = .short
        return (BuiltinTemplate.longDate(now), time.string(from: now))
    }

    private static func filled(_ s: String) -> String {
        let (d, t) = nowStrings()
        return s.replacingOccurrences(of: "{date}", with: d, options: .caseInsensitive)
            .replacingOccurrences(of: "{time}", with: t, options: .caseInsensitive)
    }

    // MARK: Using a template on the open page

    func applyBuiltin(_ t: BuiltinTemplate, pageId: String, host: PageEditHost, _ session: SessionModel, _ shell: Shell) {
        guard !busy else { return }
        busy = true
        let (date, time) = Self.nowStrings()
        let json = t.contentJson()
        host.boxCall({ live in _ = try live.insertTemplateContent(contentJson: json, kind: "canvas", date: date, time: time) }) { err in
            self.busy = false
            if let err { shell.say(SessionModel.plainMessage(err)); return }
            let set = self.fillMeta(pageId, title: t.title(Date()), icon: t.icon, session)
            shell.say("Started from \(t.name)", undo: { self.startBlank(pageId, host, session, taskIds: [], set) })
        }
    }

    func applyUser(_ t: TemplateInfo, pageId: String, host: PageEditHost, _ session: SessionModel, _ shell: Shell) {
        guard !busy else { return }
        busy = true
        session.call({ try $0.useTemplate(templateId: t.id, pageId: pageId) }) { r in
            switch r {
            case let .success(content):
                self.insert(content, name: t.name, fallbackIcon: t.icon, pageId: pageId, host: host, session, shell)
            case let .failure(e):
                self.busy = false
                if !(e is CancellationError) { shell.say(SessionModel.plainMessage(e)) }
            }
        }
    }

    private func insert(_ c: TemplateContent, name: String, fallbackIcon: String?, pageId: String, host: PageEditHost,
                        _ session: SessionModel, _ shell: Shell) {
        let (date, time) = Self.nowStrings()
        host.boxCall({ live in _ = try live.insertTemplateContent(contentJson: c.contentJson, kind: c.kind, date: date, time: time) }) { err in
            self.busy = false
            if let err { shell.say(SessionModel.plainMessage(err)); return }
            let set = self.fillMeta(pageId, title: Self.filled(c.title), icon: c.icon ?? fallbackIcon, session)
            shell.say("Started from \(name)", undo: { self.startBlank(pageId, host, session, taskIds: c.taskIds, set) })
        }
    }

    /// Title and icon from the template, only when the page has none. Returns what was set (to take it back).
    private func fillMeta(_ pageId: String, title: String, icon: String?, _ session: SessionModel) -> (title: Bool, icon: Bool) {
        let meta = session.tree?.pages.first { $0.id == pageId }
        let setTitle = (meta?.title ?? "").isEmpty && !title.isEmpty
        let setIcon = (meta?.icon ?? "").isEmpty && !(icon ?? "").isEmpty
        if setTitle || setIcon {
            session.changeTree({ core, _ -> Void in
                if setTitle { try core.renamePage(pageId: pageId, title: title) }
                if setIcon { try core.setPageIcon(pageId: pageId, icon: icon) }
            }) { _ in }
        }
        return (setTitle, setIcon)
    }

    /// "Start blank": the one undo step takes the boxes and settings back; the tasks the template made are deleted.
    private func startBlank(_ pageId: String, _ host: PageEditHost, _ session: SessionModel, taskIds: [String], _ set: (title: Bool, icon: Bool)) {
        host.boxCall({ live in _ = try live.undo() }) { _ in }
        guard !taskIds.isEmpty || set.title || set.icon else { return }
        session.changeTree({ core, _ -> Void in
            for id in taskIds { try? core.deleteTask(taskId: id) }
            if set.title { try? core.renamePage(pageId: pageId, title: "") }
            if set.icon { try? core.setPageIcon(pageId: pageId, icon: nil) }
        }) { _ in session.scheduleTaskRefresh() }
    }

    /// A page made from a template (or a section default) opened and synced: fill it, once.
    func consume(pageId: String, host: LivePageModel, _ session: SessionModel, _ shell: Shell) {
        guard let p = pending.removeValue(forKey: pageId) else { return }
        switch p {
        case let .builtin(id):
            if let t = BuiltinTemplate.all.first(where: { $0.id == id }) { applyBuiltin(t, pageId: pageId, host: host, session, shell) }
        case .claim:
            // Someone typed first: the pending template is dropped.
            let empty = host.snapshot?.info.boxes.isEmpty ?? true
            session.call({ try $0.claimPendingTemplate(pageId: pageId, discard: !empty) }) { r in
                switch r {
                case let .success(content):
                    guard let content else { return }
                    let name = self.items.first { $0.id == content.templateId }?.name ?? (content.title.isEmpty ? "template" : content.title)
                    self.insert(content, name: name, fallbackIcon: nil, pageId: pageId, host: host, session, shell)
                case let .failure(e):
                    if !(e is CancellationError) { shell.say(SessionModel.plainMessage(e)) }
                }
            }
        }
    }

    // MARK: New pages

    /// "New page from template" (a built-in or a saved one) in a section.
    func newPage(in sectionId: String, builtin: BuiltinTemplate?, template: TemplateInfo?, _ session: SessionModel, _ shell: Shell) {
        guard session.canEditTree else { shell.say("You can only view this workspace."); return }
        session.changeTree({ core, _ -> (String, Pending?) in
            if let template {
                let c = try core.createPageFromTemplate(sectionId: sectionId, title: nil, template: template.id)
                return (c.id, c.pendingTemplate == nil ? nil : Pending.claim)
            }
            let id = try core.createPage(sectionId: sectionId, title: nil)
            return (id, builtin.map { Pending.builtin($0.id) })
        }) { r in
            switch r {
            case let .success((id, pending)):
                if let pending { self.pending[id] = pending }
                shell.expanded.insert(sectionId)
                shell.open(page: id)
            case let .failure(e):
                if !(e is CancellationError) { shell.say(SessionModel.plainMessage(e)) }
            }
        }
    }

    func setDefault(_ sectionId: String, _ choice: DefaultTemplateChoice, _ session: SessionModel, _ shell: Shell) {
        session.call({ try $0.setSectionDefaultTemplate(sectionId: sectionId, choice: choice) }) { r in
            switch r {
            case .success:
                self.load(session)
                shell.sheet = nil
            case let .failure(e):
                if !(e is CancellationError) { shell.say(SessionModel.plainMessage(e)) }
            }
        }
    }

    func save(name: String, pageId: String, host: PageEditHost, _ session: SessionModel, _ shell: Shell) {
        var json = ""
        host.boxCall({ live in json = live.canvasTemplateJson() }) { err in
            if let err { shell.say(SessionModel.plainMessage(err)); return }
            let icon = session.tree?.pages.first { $0.id == pageId }?.icon
            let body = json
            session.call({ try $0.savePageAsTemplate(pageId: pageId, name: name, icon: icon, contentJson: body, kind: "canvas", sections: nil) }) { r in
                switch r {
                case let .success(info):
                    self.items.append(info)
                    shell.sheet = nil
                    shell.say("Template saved")
                case let .failure(e):
                    if !(e is CancellationError) { shell.say(SessionModel.plainMessage(e)) }
                }
            }
        }
    }

    func rename(_ t: TemplateInfo, to name: String, _ session: SessionModel, _ shell: Shell) {
        session.call({ try $0.updateTemplate(id: t.id, name: name, icon: nil, sections: nil) }) { r in
            switch r {
            case let .success(info):
                if let i = self.items.firstIndex(where: { $0.id == info.id }) { self.items[i] = info }
                shell.sheet = nil
                shell.say("Template renamed")
            case let .failure(e):
                if !(e is CancellationError) { shell.say(SessionModel.plainMessage(e)) }
            }
        }
    }

    func delete(_ t: TemplateInfo, _ session: SessionModel, _ shell: Shell) {
        session.call({ try $0.deleteTemplate(id: t.id) }) { r in
            switch r {
            case .success:
                self.items.removeAll { $0.id == t.id }
                shell.sheet = nil
                shell.say("Template deleted")
            case let .failure(e):
                if !(e is CancellationError) { shell.say(SessionModel.plainMessage(e)) }
            }
        }
    }
}

// MARK: Picker on an empty page

/// "Start with a template, or just type": over an empty page, built-ins first, then the workspace's templates offered here.
struct TemplatePickerView: View {
    let pageId: String
    let host: PageEditHost?
    @Environment(SessionModel.self) private var session
    @Environment(Shell.self) private var shell
    @Environment(\.phoneLayout) private var phone
    private let model = TemplatesModel.shared
    let theme = Theme.shared

    var body: some View {
        let p = theme.page
        let tree = session.shownTree
        let section = tree?.pages.first { $0.id == pageId }?.sectionId
        let mine = model.items.filter { TemplatesModel.offer($0, section: section, tree: tree) != nil }
        VStack(alignment: .leading, spacing: 10) {
            Text("Start with a template, or just type").font(.web(12.5, 500)).foregroundStyle(p.textMuted.color)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(BuiltinTemplate.all) { t in
                        card(icon: t.icon, name: t.name, hint: t.description) {
                            if let host { model.applyBuiltin(t, pageId: pageId, host: host, session, shell) }
                        }
                    }
                }
            }
            if !mine.isEmpty {
                Text("Your templates").font(.web(12.5, 500)).foregroundStyle(p.textMuted.color).padding(.top, 4)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(mine, id: \.id) { t in
                            card(icon: t.icon ?? "📋", name: t.name,
                                 hint: t.visibility == "private" ? "Only you can see this template" : "Shared with the workspace") {
                                if let host { model.applyUser(t, pageId: pageId, host: host, session, shell) }
                            }
                            .contextMenu {
                                if t.canManage {
                                    Button("Rename") { shell.sheet = .renameTemplate(t.id) }
                                    Button("Delete", role: .destructive) { shell.sheet = .deleteTemplate(t.id) }
                                }
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, phone ? 16 : 56)
        .padding(.top, phone ? 150 : 170)
        .onAppear { model.load(session) }
    }

    private func card(icon: String, name: String, hint: String, _ action: @escaping () -> Void) -> some View {
        let p = theme.page
        return Button(action: action) {
            HStack(spacing: 8) {
                Text(icon).font(.system(size: 18))
                Text(name).font(.web(14, 500)).foregroundStyle(p.text.color).lineLimit(1)
            }
            .padding(.horizontal, 14).frame(height: 44)
            .background(p.bgElevated.color, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(p.border.color, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityHint(hint)
    }
}

// MARK: Sheets

/// "Save as template…" (page menu): a name; the page's boxes and settings become a template for the workspace.
struct SaveTemplateCard: View {
    let pageId: String
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var name = ""
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let ok = !trimmed.isEmpty && trimmed.count <= 100 && !busy
        DialogCard(title: "Save page as template",
                   description: "Its boxes and page settings become a template anyone in the workspace can start a page from. Tasks on the page are copied as new tasks when it is used.",
                   width: width, close: { shell.sheet = nil }) {
            DialogField(label: "Name", placeholder: "Weekly review", text: $name, focused: $focused) { if ok { save() } }
        } foot: {
            DialogButton(title: "Cancel") { shell.sheet = nil }
            DialogButton(title: "Save template", style: .primary, enabled: ok) { save() }
        }
        .onAppear {
            name = session.tree?.pages.first { $0.id == pageId }?.title ?? ""
            if LookData.state == nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { focused = true } }
        }
    }

    private func save() {
        guard let host = shell.openLive else { return }
        busy = true
        TemplatesModel.shared.save(name: name.trimmingCharacters(in: .whitespaces), pageId: pageId, host: host, session, shell)
    }
}

/// "New page from template" (section menu, Notes ribbon): the built-ins and the saved templates offered in the section.
struct NewFromTemplateCard: View {
    let sectionId: String
    let width: CGFloat
    let listHeight: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    private let model = TemplatesModel.shared
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let tree = session.shownTree
        let mine = model.items.filter { TemplatesModel.offer($0, section: sectionId, tree: tree) != nil }
        DialogCard(title: "New page from template", width: width, close: { shell.sheet = nil }, hasFoot: false) {
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(BuiltinTemplate.all) { t in
                        row(icon: t.icon, name: t.name, detail: t.description, p) {
                            shell.sheet = nil
                            model.newPage(in: sectionId, builtin: t, template: nil, session, shell)
                        }
                    }
                    if !mine.isEmpty {
                        Text("Your templates").font(.web(11.5, 600)).foregroundStyle(p.textMuted.color)
                            .padding(.horizontal, 8).padding(.top, 10).padding(.bottom, 4)
                        ForEach(mine, id: \.id) { t in
                            row(icon: t.icon ?? "📋", name: t.name, detail: t.visibility == "private" ? "Only you" : "Workspace", p) {
                                shell.sheet = nil
                                model.newPage(in: sectionId, builtin: nil, template: t, session, shell)
                            }
                        }
                    }
                }
            }
            .frame(maxHeight: listHeight)
        } foot: {
            EmptyView()
        }
        .onAppear { model.load(session) }
    }

    private func row(icon: String, name: String, detail: String, _ p: Palette, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Text(icon).font(.system(size: 18)).frame(width: 26)
                Text(name).font(.web(14)).foregroundStyle(p.text.color).lineLimit(1)
                Spacer(minLength: 8)
                Text(detail).font(.web(12)).foregroundStyle(p.textMuted.color).lineLimit(1)
            }
            .padding(.horizontal, 8).frame(height: 38)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
    }
}

/// "Default template…" (section menu): what a new page in the section starts from.
struct DefaultTemplateCard: View {
    let sectionId: String
    let width: CGFloat
    let listHeight: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    private let model = TemplatesModel.shared
    let theme = Theme.shared

    var body: some View {
        let p = theme.chrome
        let tree = session.shownTree
        let name = tree?.sections.first { $0.id == sectionId }?.name ?? "section"
        let own = model.defaults.first { $0.sectionId == sectionId }
        let choices = model.items.filter { $0.visibility == "workspace" && TemplatesModel.offer($0, section: sectionId, tree: tree) != nil }
        let inherits = own == nil || (own?.defaultTemplateId == nil && own?.noDefaultTemplate != true)
        DialogCard(title: "Default template", description: "What a new page in “\(name)” starts from.", width: width,
                   close: { shell.sheet = nil }, hasFoot: false) {
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    row("Same as the parent section", selected: inherits, p) {
                        model.setDefault(sectionId, .inherit, session, shell)
                    }
                    row("None (blank pages)", selected: own?.noDefaultTemplate == true, p) {
                        model.setDefault(sectionId, .noDefault, session, shell)
                    }
                    ForEach(choices, id: \.id) { t in
                        row("\(t.icon ?? "📋") \(t.name)", selected: own?.defaultTemplateId == t.id, p) {
                            model.setDefault(sectionId, .template(id: t.id), session, shell)
                        }
                    }
                    if choices.isEmpty {
                        SheetNote(text: "Save a page as a template (page menu) to choose it here.").padding(8)
                    }
                }
            }
            .frame(maxHeight: listHeight)
        } foot: {
            EmptyView()
        }
        .onAppear { model.load(session) }
    }

    private func row(_ title: String, selected: Bool, _ p: Palette, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title).font(.web(14)).foregroundStyle((selected ? p.accent : p.text).color).lineLimit(1)
                Spacer(minLength: 0)
                if selected { Icon("check", 14, p.accent.color) }
            }
            .padding(.horizontal, 8).frame(height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(radius: 6, pressed: p.bgHover.color))
    }
}

/// Rename or delete a saved template (creator or workspace admin; the server checks).
struct ManageTemplateCard: View {
    let id: String
    let delete: Bool
    let width: CGFloat
    @Environment(Shell.self) private var shell
    @Environment(SessionModel.self) private var session
    @State private var name = ""
    @FocusState private var focused: Bool
    private let model = TemplatesModel.shared

    var body: some View {
        let t = model.items.first { $0.id == id }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if delete {
            DialogCard(title: "Delete template “\(t?.name ?? "")”?", description: "Pages already made from it keep their content. This can’t be undone.",
                       width: width, close: { shell.sheet = nil }, hasBody: false) {
                EmptyView()
            } foot: {
                DialogButton(title: "Cancel") { shell.sheet = nil }
                DialogButton(title: "Delete template", style: .danger) { if let t { model.delete(t, session, shell) } }
            }
        } else {
            DialogCard(title: "Rename template", width: width, close: { shell.sheet = nil }) {
                DialogField(label: "Name", placeholder: "", text: $name, focused: $focused) {
                    if let t, !trimmed.isEmpty { model.rename(t, to: trimmed, session, shell) }
                }
            } foot: {
                DialogButton(title: "Cancel") { shell.sheet = nil }
                DialogButton(title: "Rename", style: .primary, enabled: !trimmed.isEmpty && trimmed.count <= 100) {
                    if let t { model.rename(t, to: trimmed, session, shell) }
                }
            }
            .onAppear { name = t?.name ?? "" }
        }
    }
}
