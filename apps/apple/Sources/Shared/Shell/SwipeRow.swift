import SwiftUI

/// Swipe actions for a list row on a touch screen (src/components/shell/SwipeRow.tsx): `right` is revealed by swiping right,
/// `left` by swiping left. Past a third of the row's width, letting go does the action; a vertical swipe is the list's own
/// scroll. The actions are reachable another way too (the circle, the task sheet).
struct SwipeRow<Content: View>: View {
    struct Action {
        let label: String
        let icon: String
        /// The success colour (green) or the accent.
        var success = false
        let run: () -> Void
    }

    var right: Action?
    var left: Action?
    var disabled = false
    @ViewBuilder let content: () -> Content
    @State private var dx: CGFloat = 0
    @State private var width: CGFloat = 1
    /// Whether this drag is a horizontal swipe (nil until it has moved far enough to tell).
    @State private var horizontal: Bool?
    @State private var settling = false
    let theme = Theme.shared

    private let threshold: CGFloat = 0.32
    private let maximum: CGFloat = 0.85

    var body: some View {
        if disabled || (left == nil && right == nil) {
            content()
        } else {
            let p = theme.chrome
            let action = dx > 0 ? right : dx < 0 ? left : nil
            let armed = abs(dx) > width * threshold
            ZStack {
                if let action {
                    HStack(spacing: 6) {
                        if dx < 0 { Spacer(minLength: 0) }
                        Icon(action.icon, 18, .white)
                        Text(action.label).font(.web(13, 600)).foregroundStyle(.white)
                        if dx > 0 { Spacer(minLength: 0) }
                    }
                    .padding(.horizontal, 18)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background((action.success ? p.success : p.accentSolid).color.opacity(armed ? 1 : 0.8))
                }
                content()
                    .background(dx == 0 ? Color.clear : p.bg.color)
                    .offset(x: dx)
            }
            .clipped()
            .background(GeometryReader { g in
                Color.clear
                    .onAppear { width = max(g.size.width, 1) }
                    .onChange(of: g.size.width) { _, w in width = max(w, 1) }
            })
            .simultaneousGesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { v in
                        if settling { return }
                        if horizontal == nil { horizontal = abs(v.translation.width) > abs(v.translation.height) * 1.2 }
                        guard horizontal == true else { return }
                        var next = v.translation.width
                        if next > 0 && right == nil { next = 0 }
                        if next < 0 && left == nil { next = 0 }
                        dx = max(-width * maximum, min(width * maximum, next))
                    }
                    .onEnded { _ in
                        let swiped = horizontal == true
                        horizontal = nil
                        guard swiped, !settling else { return }
                        if abs(dx) > width * threshold, let action = dx > 0 ? right : left {
                            // Slide out, then do it and spring back (the row usually changes or goes).
                            settling = true
                            withAnimation(.easeOut(duration: 0.16)) { dx = dx > 0 ? width : -width }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) {
                                action.run()
                                withAnimation(.easeOut(duration: 0.2)) { dx = 0 }
                                settling = false
                            }
                        } else {
                            withAnimation(.easeOut(duration: 0.2)) { dx = 0 }
                        }
                    }
            )
        }
    }
}
