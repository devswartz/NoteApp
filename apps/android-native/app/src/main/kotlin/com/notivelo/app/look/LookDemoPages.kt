package com.notivelo.app.look

import com.notivelo.core.BoxContent
import com.notivelo.core.PageBox

/** The demo seed's two showcase pages (server/demoContent.ts): Weekly sync and Q4 roadmap, written to the page's `default` fragment (a document page). */
internal object LookDemoPages {
    val meeting = LookPage(
        boxes = emptyList(),
        content = listOf(
            BoxContent(
                null,
                listOf(
                    p(bold("Date: "), "Saturday 21 November"),
                    h(2, "Attendees"),
                    bullets(listOf("Demo User"), listOf("Sam Teammate")),
                    h(2, "Agenda"),
                    numbered(listOf("Roadmap check-in"), listOf("Launch pricing"), listOf("Search performance")),
                    h(2, "Notes"),
                    p("We are on track for the ", pageLink("q4-roadmap"), ". ", commented("Search feels slow on very long pages", "thread"), "; Sam will benchmark it."),
                    quote(italic("“Ship the small thing, then make it great.”")),
                    h(2, "Decisions"),
                    bullets(listOf("Launch with two pricing tiers"), listOf("Keep the weekly sync on Mondays")),
                    h(2, "Action items"),
                    taskRef("t-notes"),
                    taskRef("m-pricing"),
                    taskRef("m-standup"),
                    callout("✅", p("Action items are real tasks: they show up on everyone’s dashboard, and ", bold("Finalise launch pricing"), " has subtasks.")),
                ),
            ),
        ),
    )

    val roadmap = LookPage(
        boxes = emptyList(),
        content = listOf(
            BoxContent(
                null,
                listOf(
                    callout("🎯", p(bold("Goal: "), "ship collaborative notes with real tasks to the whole team by the end of the quarter.")),
                    h(2, "Milestones"),
                    table(
                        listOf("Milestone", "Owner", "Target"),
                        listOf("Editor and tasks", "Demo User", "October"),
                        listOf("Search and offline", "Sam Teammate", "November"),
                        listOf("Desktop and mobile apps", "Demo User", "December"),
                    ),
                    h(2, "Plan"),
                    p("The marketing side lives in ", pageLink("launch"), ", and the technical design in ", pageLink("spec"), "."),
                    numbered(listOf("Private beta with the core team"), listOf("Public beta and feedback"), listOf("General availability")),
                    toggle("Out of scope this quarter", bullets(listOf("Public share links"), listOf("AI summaries"), listOf("Calendar sync"))),
                ),
            ),
        ),
    )
}
