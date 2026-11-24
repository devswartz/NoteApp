package com.notivelo.app.ui.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.notivelo.app.data.AppState
import com.notivelo.app.data.ShellActions
import com.notivelo.app.data.TaskList
import com.notivelo.app.look.Ic
import com.notivelo.app.look.LIcon
import com.notivelo.app.look.WText
import com.notivelo.app.look.pal
import com.notivelo.app.ui.tappable

/** The Tasks panel (the sidebar on Tasks): title, "Add task", the views with counts, VIEWS and "New view". */
@Composable
fun TasksPanel(state: AppState, actions: ShellActions, onNotYet: (String) -> Unit, onPicked: () -> Unit = {}) {
    val p = pal()
    val buckets = rememberBuckets(state)
    Column(Modifier.fillMaxWidth()) {
        WText("Tasks", 15f, p.text, Modifier.padding(horizontal = 16.dp).height(52.dp).padding(top = 15.dp), weight = 650, lineHeight = 1.3f)
        Column(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(
                Modifier.fillMaxWidth().height(32.dp).tappable { onNotYet("Adding a task") }.padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                LIcon(Ic.plus, 16.dp, p.accent)
                WText("Add task", 14f, p.accent, Modifier.weight(1f), weight = 500, lineHeight = 1.3f)
                Box(
                    Modifier.defaultMinSize(minWidth = 18.dp, minHeight = 18.dp).background(p.bg, RoundedCornerShape(4.dp)).border(1.dp, p.border, RoundedCornerShape(4.dp)).padding(horizontal = 4.dp),
                    contentAlignment = Alignment.Center,
                ) { WText("Q", 11f, p.textMuted, weight = 500, lineHeight = 1f) }
            }
            Box(Modifier.height(10.dp))
            for (list in TaskList.entries) {
                val active = state.tab == com.notivelo.app.data.Tab.Tasks && state.taskList == list
                val n = buckets.count(list)
                Row(
                    Modifier.fillMaxWidth().height(32.dp)
                        .background(if (active) p.bgActive else Color.Transparent, RoundedCornerShape(7.dp))
                        .tappable { actions.selectTaskList(list); onPicked() }
                        .padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    LIcon(
                        when (list) {
                            TaskList.Today -> Ic.sun
                            TaskList.My -> Ic.inbox
                            TaskList.Upcoming -> Ic.calendarRange
                            TaskList.All -> Ic.listChecks
                        },
                        16.dp, if (active) p.accent else p.text2,
                    )
                    WText(list.title, 14f, if (active) p.accent else p.text2, Modifier.weight(1f), weight = 500, lineHeight = 1.3f)
                    if (n > 0) {
                        val alarm = list == TaskList.Today && buckets.overdue > 0
                        val fg = if (alarm) p.danger else p.text2
                        Box(
                            Modifier.defaultMinSize(minWidth = 18.dp, minHeight = 18.dp)
                                .background(if (alarm) p.danger.copy(alpha = if (p.dark) 0.12f else 0.08f) else p.bgHover, RoundedCornerShape(50))
                                .padding(horizontal = 6.dp),
                            contentAlignment = Alignment.Center,
                        ) { WText("$n", 10.5f, fg, weight = 600, lineHeight = 1f) }
                    }
                }
            }
            Box(Modifier.height(16.dp))
            WText("VIEWS", 11.5f, p.textMuted, Modifier.padding(start = 10.dp).height(26.dp).padding(top = 5.dp), weight = 600, tracking = 0.04f)
            Row(
                Modifier.fillMaxWidth().height(32.dp).tappable { onNotYet("Saved views") }.padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                LIcon(Ic.plus, 16.dp, p.text2)
                WText("New view", 14f, p.text2, weight = 500, lineHeight = 1.3f)
            }
        }
    }
}
