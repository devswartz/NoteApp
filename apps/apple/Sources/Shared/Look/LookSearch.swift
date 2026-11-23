import Foundation

/// What the web's look seed has that the corpus tree doesn't: the pages and tasks the search reference ("plan")
/// finds. Only the search palette reads these (corpus mode); the sidebar and the task lists stay as they are.
extension LookData {
    static let searchPages: [(id: String, title: String, crumb: String, snippet: String?)] = [
        ("look-launch-plan", "Launch plan", "Marketing › Launch", nil),
        ("look-q4-roadmap", "Q4 roadmap", "Product › Roadmap", "…and mobile apps Demo User December «Plan» The marketing side …"),
    ]

    /// (id, title, days from today). "Write the plan" is the corpus task t1.
    static let searchTasks: [(id: String, title: String, due: Int)] = [
        ("look-elders", "Plan the elders’ retreat", 10),
        ("t1", "Write the plan", 9),
    ]
}
