# Lucide icons used by the web app

lucide-react 1.68.0. 164 icons, exported by `../export-icons.mjs` from the package's icon data: 24×24 viewBox, `stroke="currentColor"`, stroke width 2 (in 24ths of the icon: at size 16 the line is 1.33 px), round caps and joins, no fill. Sizes are the `size={…}` props in the source ("css": no size prop, the CSS sets it, e.g. ribbon buttons 18 px; "via prop": passed as a component and sized where drawn). See `docs/rewrite/LOOK.md`, Icons.

| SVG | Imported as | Sizes (px) | Used in (src/) |
|---|---|---|---|
| `activity.svg` | Activity | 15, 16, 20 | `components/sharing/ActivityFeed.tsx`, `components/shell/Rail.tsx`, `components/shell/commands.tsx` |
| `alarm-clock.svg` | AlarmClock | via prop | `components/sharing/NotificationBell.tsx` |
| `arrow-down-to-line.svg` | ArrowDownToLine | 14 | `editor/NoteEditor.tsx` |
| `arrow-down-up.svg` | ArrowDownUp | 15 | `components/shell/NotesPanel.tsx` |
| `arrow-left.svg` | ArrowLeft | css | `components/shell/SectionRibbons.tsx` |
| `arrow-right-to-line.svg` | ArrowRightToLine | 14 | `editor/NoteEditor.tsx` |
| `arrow-up-down.svg` | ArrowUpDown | css | `components/shell/SectionRibbons.tsx` |
| `at-sign.svg` | AtSign | via prop | `components/sharing/NotificationBell.tsx` |
| `ban.svg` | Ban | 15 | `components/Labels.tsx`, `components/TaskControls.tsx` |
| `baseline.svg` | Baseline | 16 | `editor/Toolbar.tsx` |
| `bell.svg` | Bell | 12, 13, 15, 16, var | `components/TaskDetail.tsx`, `components/notifications/NotificationSettingsPanel.tsx`, `components/notifications/ReminderPicker.tsx`, `components/notifications/TaskIndicators.tsx`, `components/sharing/NotificationBell.tsx`, `pages/Settings.tsx` |
| `between-horizontal-end.svg` | BetweenHorizontalEnd | css | `editor/Toolbar.tsx` |
| `between-horizontal-start.svg` | BetweenHorizontalStart | css | `editor/Toolbar.tsx` |
| `between-vertical-end.svg` | BetweenVerticalEnd | css | `editor/Toolbar.tsx` |
| `between-vertical-start.svg` | BetweenVerticalStart | css | `editor/Toolbar.tsx` |
| `book-open.svg` | BookOpen | 22, via prop | `components/shell/MobileChrome.tsx`, `components/shell/Rail.tsx`, `pages/TrashView.tsx` |
| `book-plus.svg` | BookPlus | 15, 16, css | `components/shell/NotesPanel.tsx`, `components/shell/SectionRibbons.tsx`, `components/shell/commands.tsx` |
| `bookmark.svg` | Bookmark | 12, 15, css | `components/shell/SectionRibbons.tsx`, `components/shell/TasksPanel.tsx`, `pages/tasks/AllView.tsx` |
| `bookmark-plus.svg` | BookmarkPlus | 15, css | `components/shell/SectionRibbons.tsx`, `pages/tasks/AllView.tsx` |
| `building-complex.svg` | Building2 | 16 | `pages/Settings.tsx` |
| `calendar-clock.svg` | CalendarClock | 15, 18 | `components/TaskControls.tsx`, `components/TaskRow.tsx` |
| `calendar-days.svg` | CalendarDays | 13, 15, 16, 22, css, via prop | `components/QuickAdd.tsx`, `components/TaskControls.tsx`, `components/TaskDetail.tsx`, `components/notifications/NotificationSettingsPanel.tsx`, `components/shell/MobileChrome.tsx`, `components/shell/Rail.tsx`, `components/shell/SectionRibbons.tsx`, `components/shell/commands.tsx`, `pages/tasks/BulkBar.tsx` |
| `calendar-range.svg` | CalendarRange | 16, css | `components/shell/SectionRibbons.tsx`, `components/shell/TasksPanel.tsx`, `components/shell/commands.tsx` |
| `check.svg` | Check | 11, 12, 13, 14, 15, 18 (stroke 3) | `components/TaskRow.tsx`, `components/shell/AppearanceSettings.tsx`, `components/shell/MoveDialog.tsx`, `components/shell/notesRows.tsx`, `components/ui.tsx`, `editor/blocks.tsx`, `editor/collabCommentsPanel.tsx`, `pages/PageView.tsx`, `pages/tasks/FilterChips.tsx` |
| `check-check.svg` | CheckCheck | 14 | `components/sharing/NotificationBell.tsx` |
| `chevron-down.svg` | ChevronDown | 12, 13, 14 | `components/shell/NotesPanel.tsx`, `components/shell/Rail.tsx`, `components/shell/notesRows.tsx`, `editor/TaskRef.tsx`, `editor/Toolbar.tsx` |
| `chevron-left.svg` | ChevronLeft | 15, 16, 18, 22, css | `components/MiniCalendar.tsx`, `components/shell/CalendarPanel.tsx`, `components/shell/MobileChrome.tsx`, `components/shell/SectionRibbons.tsx`, `components/shell/SectionTemplates.tsx`, `components/shell/notesRows.tsx`, `pages/NotesHome.tsx`, `pages/Settings.tsx`, `pages/tasks/CalendarView.tsx`, `pages/tasks/FilterChips.tsx` |
| `chevron-right.svg` | ChevronRight | 13, 14, 15, 16, 17, 18, css | `components/MiniCalendar.tsx`, `components/shell/CalendarPanel.tsx`, `components/shell/SectionRibbons.tsx`, `components/shell/notesRows.tsx`, `editor/SlashMenu.tsx`, `editor/TaskRef.tsx`, `pages/NotesHome.tsx`, `pages/PageView.tsx`, `pages/Settings.tsx`, `pages/tasks/CalendarView.tsx` |
| `chevron-up.svg` | ChevronUp | 16 | `editor/Toolbar.tsx` |
| `circle-check.svg` | CircleCheck, CheckCircle2 | 11, 14, 15, 16, 18, css | `components/CommandPalette.tsx`, `components/shell/notesRows.tsx`, `editor/NoteEditor.tsx`, `editor/SlashMenu.tsx`, `editor/Toolbar.tsx`, `pages/PageView.tsx`, `pages/tasks/BulkBar.tsx` |
| `clipboard-paste.svg` | ClipboardPaste | 15 | `editor/CanvasEditor.tsx` |
| `clock.svg` | Clock | 12, 15, 16 | `components/TaskDetail.tsx`, `components/notifications/NotificationSettingsPanel.tsx`, `components/shell/NotesPanel.tsx` |
| `cloud-off.svg` | CloudOff | 14 | `pages/PageView.tsx` |
| `code.svg` | Code | 16 | `editor/NoteEditor.tsx` |
| `code-xml.svg` | Code2 | 16, 18 | `editor/SlashMenu.tsx`, `editor/Toolbar.tsx` |
| `columns-3.svg` | Columns3 | 14, css | `editor/NoteEditor.tsx`, `editor/Toolbar.tsx` |
| `contrast.svg` | Contrast | 15, via prop | `components/shell/AppearanceSettings.tsx`, `components/shell/Rail.tsx` |
| `copy.svg` | Copy | 13, 14, 15 | `components/sharing/MembersPanel.tsx`, `components/sharing/PageShareDialog.tsx`, `components/shell/notesRows.tsx`, `editor/CanvasEditor.tsx`, `editor/PrintSelectionMenu.tsx`, `editor/blocks.tsx`, `pages/PageView.tsx` |
| `copy-plus.svg` | CopyPlus | 15 | `editor/CanvasEditor.tsx` |
| `corner-down-right.svg` | CornerDownRight | 12, 13, 14 | `components/TaskDetail.tsx`, `components/TaskRow.tsx`, `components/TeamsSettings.tsx` |
| `download.svg` | Download | 15, 16 | `components/WorkspaceData.tsx`, `components/shell/Rail.tsx`, `editor/blocks.tsx`, `pages/Settings.tsx` |
| `ellipsis.svg` | MoreHorizontal | 13, 14, 15, 16, 18 | `components/TeamsSettings.tsx`, `components/shell/notesRows.tsx`, `editor/collabCommentsPanel.tsx`, `pages/PageView.tsx`, `pages/tasks/AllView.tsx` |
| `eraser.svg` | Eraser | via prop | `ink/InkToolbar.tsx` |
| `external-link.svg` | ExternalLink | 15 | `components/sharing/PageShareDialog.tsx`, `editor/LinkEditor.tsx` |
| `eye.svg` | Eye | css | `components/shell/SectionRibbons.tsx` |
| `face-slightly-smiling-plus.svg` | SmilePlus | 15 | `pages/PageView.tsx` |
| `file.svg` | File | 20 | `editor/blocks.tsx` |
| `file-archive.svg` | FileArchive | 20 | `editor/blocks.tsx` |
| `file-cog.svg` | FileCog | 15 | `components/shell/notesRows.tsx` |
| `file-down.svg` | FileDown | 15 | `pages/PageView.tsx` |
| `file-headphone.svg` | FileAudio | 20 | `editor/blocks.tsx` |
| `file-image.svg` | FileImage | 20 | `editor/blocks.tsx` |
| `file-play.svg` | FileVideo | 20 | `editor/blocks.tsx` |
| `file-plus.svg` | FilePlus | 15, 16, css | `components/shell/NotesPanel.tsx`, `components/shell/SectionRibbons.tsx`, `components/shell/commands.tsx`, `pages/NotesHome.tsx` |
| `file-spreadsheet.svg` | FileSpreadsheet | 20 | `editor/blocks.tsx` |
| `file-symlink.svg` | FileSymlink | 18, css | `editor/SlashMenu.tsx`, `editor/Toolbar.tsx` |
| `file-text.svg` | FileText | 12, 13, 14, 15, 20, 28, var, via prop | `components/PageKindIcon.tsx`, `components/QuickAdd.tsx`, `components/TaskDetail.tsx`, `components/TaskRow.tsx`, `components/sharing/SharedWithMe.tsx`, `components/shell/SectionTemplates.tsx`, `editor/PageLink.tsx`, `editor/blocks.tsx`, `pages/NotesHome.tsx`, `pages/PageView.tsx`, `pages/TrashView.tsx` |
| `file-up.svg` | FileUp | 15 | `components/OneNoteImport.tsx`, `pages/PageView.tsx` |
| `file-x-corner.svg` | FileX2 | 15 | `editor/TaskRef.tsx` |
| `fingerprint-pattern.svg` | Fingerprint | 16 | `components/LockedNotes.tsx` |
| `flag.svg` | Flag | 13, 14, 15, css | `components/QuickAdd.tsx`, `components/TaskControls.tsx`, `components/TaskDetail.tsx`, `components/shell/SectionRibbons.tsx`, `editor/TaskRef.tsx`, `pages/tasks/BulkBar.tsx` |
| `folder.svg` | Folder | via prop | `pages/TrashView.tsx` |
| `folder-input.svg` | FolderInput | 13, 15 | `components/shell/notesRows.tsx`, `pages/PageView.tsx` |
| `folder-plus.svg` | FolderPlus | 15, css | `components/shell/SectionRibbons.tsx`, `components/shell/notesRows.tsx` |
| `folder-tree.svg` | FolderTree | 13 | `editor/TemplatePicker.tsx` |
| `funnel-x.svg` | FilterX | 15, css | `components/shell/SectionRibbons.tsx` |
| `globe.svg` | Globe | 15, 16, 18 | `components/notifications/NotificationSettingsPanel.tsx`, `components/sharing/PageShareDialog.tsx`, `components/sharing/ShareDialog.tsx`, `components/shell/notesRows.tsx` |
| `grid-3x3.svg` | Grid3x3 | 16 | `editor/Toolbar.tsx` |
| `grip-vertical.svg` | GripVertical | 14, 15 | `editor/NoteEditor.tsx`, `editor/TaskRef.tsx` |
| `hand.svg` | Hand | 16 | `ink/InkToolbar.tsx` |
| `heading-1.svg` | Heading1 | 16, 18 | `editor/NoteEditor.tsx`, `editor/SlashMenu.tsx`, `editor/Toolbar.tsx` |
| `heading-2.svg` | Heading2 | 16, 18 | `editor/NoteEditor.tsx`, `editor/SlashMenu.tsx`, `editor/Toolbar.tsx` |
| `heading-3.svg` | Heading3 | 16, 18 | `editor/NoteEditor.tsx`, `editor/SlashMenu.tsx`, `editor/Toolbar.tsx` |
| `highlighter.svg` | Highlighter | 16, via prop | `editor/Toolbar.tsx`, `ink/InkToolbar.tsx` |
| `image.svg` | Image | 18 | `editor/SlashMenu.tsx` |
| `image-plus.svg` | ImagePlus | css | `editor/Toolbar.tsx` |
| `inbox.svg` | Inbox | 16, css | `components/shell/SectionRibbons.tsx`, `components/shell/TasksPanel.tsx`, `components/shell/commands.tsx` |
| `info.svg` | Info | 16 | `pages/Settings.tsx` |
| `italic.svg` | Italic | 16, css | `editor/NoteEditor.tsx`, `editor/Toolbar.tsx` |
| `keyboard.svg` | Keyboard | 15, 16 | `components/shell/Rail.tsx`, `components/shell/commands.tsx`, `pages/Settings.tsx` |
| `layers.svg` | Layers | css | `components/shell/SectionRibbons.tsx` |
| `layout-dashboard.svg` | LayoutDashboard | 15 | `components/shell/notesRows.tsx` |
| `layout-template.svg` | LayoutTemplate | 12, 15, css | `components/shell/SectionRibbons.tsx`, `components/shell/SectionTemplates.tsx`, `components/shell/notesRows.tsx`, `pages/PageView.tsx` |
| `letter-b.svg` | Bold | 16, css | `editor/NoteEditor.tsx`, `editor/Toolbar.tsx` |
| `link-2.svg` | Link2 | 15, 16, 18, css | `components/shell/notesRows.tsx`, `editor/NoteEditor.tsx`, `editor/SlashMenu.tsx`, `editor/Toolbar.tsx` |
| `link-2-off.svg` | Link2Off | 15 | `editor/LinkEditor.tsx` |
| `list.svg` | List | 18, css | `editor/SlashMenu.tsx`, `editor/Toolbar.tsx` |
| `list-checks.svg` | ListChecks | 12, 15, 16, 22, css, via prop | `components/TaskDetail.tsx`, `components/TaskRow.tsx`, `components/shell/MobileChrome.tsx`, `components/shell/Rail.tsx`, `components/shell/SectionRibbons.tsx`, `components/shell/TasksPanel.tsx`, `components/shell/commands.tsx`, `editor/Toolbar.tsx` |
| `list-indent-decrease.svg` | IndentDecrease | css | `editor/Toolbar.tsx` |
| `list-indent-increase.svg` | IndentIncrease | css | `editor/Toolbar.tsx` |
| `list-ordered.svg` | ListOrdered | 18, css | `editor/SlashMenu.tsx`, `editor/Toolbar.tsx` |
| `list-plus.svg` | ListPlus | 13, 18 | `editor/SlashMenu.tsx`, `editor/TaskRef.tsx` |
| `list-todo.svg` | ListTodo | 18 | `pages/PageView.tsx` |
| `list-tree.svg` | ListTree | css | `editor/Toolbar.tsx` |
| `loader.svg` | Loader | 14 | `pages/PageView.tsx` |
| `loader-circle.svg` | Loader2 | 15 | `components/ui.tsx` |
| `lock.svg` | Lock | 12, 13, 14, 15, 16, 18, 26 | `components/LockedNotes.tsx`, `components/sharing/PageShareDialog.tsx`, `components/sharing/ShareDialog.tsx`, `components/shell/AppLockSettings.tsx`, `components/shell/MobileChrome.tsx`, `components/shell/NotesPanel.tsx`, `components/shell/notesRows.tsx`, `pages/NotesHome.tsx`, `pages/PageView.tsx`, `pages/Settings.tsx` |
| `lock-open.svg` | LockOpen | 15 | `components/LockedNotes.tsx`, `components/shell/notesRows.tsx`, `pages/PageView.tsx` |
| `log-out.svg` | LogOut | 15, 16 | `components/sharing/MembersPanel.tsx`, `components/shell/Rail.tsx`, `pages/Settings.tsx` |
| `mail.svg` | Mail | 15, 16 | `components/notifications/NotificationSettingsPanel.tsx`, `components/sharing/MembersPanel.tsx` |
| `maximize-2.svg` | Maximize2 | 13 | `editor/TaskRef.tsx` |
| `menu.svg` | Menu | 21 | `components/shell/MobileChrome.tsx` |
| `message-square.svg` | MessageSquare | 14, 16, 18, via prop | `components/sharing/NotificationBell.tsx`, `components/shell/commands.tsx`, `editor/NoteEditor.tsx`, `editor/collabCommentsPanel.tsx`, `pages/PageView.tsx` |
| `message-square-quote.svg` | MessageSquareQuote | 18 | `editor/SlashMenu.tsx` |
| `minus.svg` | Minus | 11, 18, css (stroke 3) | `editor/SlashMenu.tsx`, `editor/Toolbar.tsx`, `pages/tasks/FilterChips.tsx` |
| `monitor.svg` | Monitor | 15, 18, via prop | `components/GetTheApps.tsx`, `components/shell/AppearanceSettings.tsx`, `components/shell/Rail.tsx` |
| `moon.svg` | Moon | 15, 16, via prop | `components/notifications/NotificationSettingsPanel.tsx`, `components/shell/AppearanceSettings.tsx`, `components/shell/Rail.tsx` |
| `mouse-pointer-2.svg` | MousePointer2 | via prop | `ink/InkToolbar.tsx` |
| `notebook-text.svg` | NotebookText | 16 | `components/shell/commands.tsx` |
| `paint-bucket.svg` | PaintBucket | css | `editor/Toolbar.tsx` |
| `palette.svg` | Palette | 16 | `pages/Settings.tsx` |
| `panel-left.svg` | PanelLeft | 16 | `components/shell/commands.tsx` |
| `panel-left-close.svg` | PanelLeftClose | 19 | `components/shell/Rail.tsx` |
| `panel-left-open.svg` | PanelLeftOpen | 19 | `components/shell/Rail.tsx` |
| `panel-top.svg` | PanelTop | 14, css | `editor/NoteEditor.tsx`, `editor/Toolbar.tsx` |
| `paperclip.svg` | Paperclip | 18, css | `editor/SlashMenu.tsx`, `editor/Toolbar.tsx` |
| `pen.svg` | Pen | via prop | `ink/InkToolbar.tsx` |
| `pencil.svg` | Pencil | 13, 15 | `components/shell/notesRows.tsx`, `editor/TemplatePicker.tsx` |
| `pilcrow.svg` | Pilcrow | 16 | `editor/Toolbar.tsx` |
| `plug.svg` | Plug | 16, 18 | `components/ConnectedApps.tsx`, `pages/Settings.tsx` |
| `plus.svg` | Plus | 13, 14, 15, 16, 26, css (stroke 2.25) | `components/CommandPalette.tsx`, `components/Labels.tsx`, `components/TaskDetail.tsx`, `components/TaskRow.tsx`, `components/TeamsSettings.tsx`, `components/notifications/ReminderPicker.tsx`, `components/shell/MobileChrome.tsx`, `components/shell/NotesPanel.tsx`, `components/shell/Rail.tsx`, `components/shell/SectionRibbons.tsx`, `components/shell/TasksPanel.tsx`, `components/shell/commands.tsx`, `components/shell/notesRows.tsx`, `editor/CanvasEditor.tsx`, `editor/NoteEditor.tsx`, `editor/PageLink.tsx`, `pages/NotesHome.tsx`, `pages/tasks/CalendarView.tsx`, `pages/tasks/FilterChips.tsx` |
| `printer.svg` | Printer | 15, 16, css | `components/shell/SectionRibbons.tsx`, `components/shell/commands.tsx`, `components/shell/notesRows.tsx`, `editor/PrintSelectionMenu.tsx`, `editor/Toolbar.tsx`, `pages/PageView.tsx` |
| `quote.svg` | Quote | 16, 18 | `editor/NoteEditor.tsx`, `editor/SlashMenu.tsx`, `editor/Toolbar.tsx` |
| `redo-2.svg` | Redo2 | 18, css | `editor/Toolbar.tsx`, `pages/PageView.tsx` |
| `remove-formatting.svg` | RemoveFormatting | css | `editor/Toolbar.tsx` |
| `repeat.svg` | Repeat | 11, 12, 13, 15 | `components/QuickAdd.tsx`, `components/TaskControls.tsx`, `components/TaskDetail.tsx`, `components/notifications/RecurrencePicker.tsx`, `components/notifications/TaskIndicators.tsx` |
| `rotate-ccw.svg` | RotateCcw | 14, 15, 18 | `components/TaskRow.tsx`, `editor/VersionHistory.tsx`, `editor/collabCommentsPanel.tsx`, `pages/tasks/BulkBar.tsx` |
| `rotate-ccw-clock.svg` | History | 15, 16 | `editor/VersionHistory.tsx`, `pages/PageView.tsx` |
| `rotate-cw.svg` | RotateCw | 16 | `components/sharing/MembersPanel.tsx` |
| `rows-3.svg` | Rows3 | 14, 16, css | `editor/NoteEditor.tsx`, `editor/Toolbar.tsx` |
| `scan-face.svg` | ScanFace | 16 | `components/LockedNotes.tsx` |
| `scissors.svg` | Scissors | 15 | `editor/CanvasEditor.tsx` |
| `search.svg` | Search | 13, 15, 16, 18, 19, 20, 22 | `components/CommandPalette.tsx`, `components/sharing/PageShareDialog.tsx`, `components/sharing/ShareDialog.tsx`, `components/shell/MobileChrome.tsx`, `components/shell/MoveDialog.tsx`, `components/shell/Rail.tsx`, `components/shell/commands.tsx`, `pages/tasks/FilterChips.tsx` |
| `send.svg` | Send | 14 | `components/notifications/NotificationSettingsPanel.tsx` |
| `settings.svg` | Settings | 15, 16 | `components/shell/Rail.tsx`, `components/shell/commands.tsx` |
| `share-2.svg` | Share2 | via prop | `components/sharing/NotificationBell.tsx` |
| `slice.svg` | Slice | via prop | `ink/InkToolbar.tsx` |
| `sliders-horizontal.svg` | SlidersHorizontal | css | `components/shell/SectionRibbons.tsx` |
| `smartphone.svg` | Smartphone | 18 | `components/GetTheApps.tsx` |
| `square-check.svg` | SquareCheck | 12 | `components/TaskRow.tsx`, `editor/TaskRef.tsx` |
| `square-check-big.svg` | CheckSquare | 18 | `editor/SlashMenu.tsx` |
| `star.svg` | Star | 15 | `components/shell/notesRows.tsx`, `pages/NotesHome.tsx` |
| `star-off.svg` | StarOff | 15 | `components/shell/notesRows.tsx` |
| `strikethrough.svg` | Strikethrough | 16, css | `editor/NoteEditor.tsx`, `editor/Toolbar.tsx` |
| `sun.svg` | Sun | 15, 16, css, via prop | `components/TaskControls.tsx`, `components/shell/AppearanceSettings.tsx`, `components/shell/Rail.tsx`, `components/shell/SectionRibbons.tsx`, `components/shell/TasksPanel.tsx`, `components/shell/commands.tsx` |
| `sun-moon.svg` | SunMoon | 16 | `components/shell/commands.tsx` |
| `sunrise.svg` | Sunrise | 15 | `components/TaskControls.tsx` |
| `table.svg` | Table | 18, css | `editor/SlashMenu.tsx`, `editor/Toolbar.tsx` |
| `table-cells-merge.svg` | TableCellsMerge | css | `editor/Toolbar.tsx` |
| `table-cells-split.svg` | TableCellsSplit | css | `editor/Toolbar.tsx` |
| `tag.svg` | Tag | 13, 15, 16, 22, css | `components/QuickAdd.tsx`, `components/TaskDetail.tsx`, `components/TeamsSettings.tsx`, `components/shell/SectionRibbons.tsx`, `pages/Settings.tsx` |
| `text-align-start.svg` | AlignLeft | 13 | `components/TaskRow.tsx` |
| `trash.svg` | Trash2 | 13, 14, 15, 16, 20, css | `components/DeleteAccount.tsx`, `components/TaskDetail.tsx`, `components/notifications/ReminderPicker.tsx`, `components/sharing/MembersPanel.tsx`, `components/shell/Rail.tsx`, `components/shell/commands.tsx`, `components/shell/notesRows.tsx`, `editor/CanvasEditor.tsx`, `editor/NoteEditor.tsx`, `editor/TemplatePicker.tsx`, `editor/Toolbar.tsx`, `editor/collabCommentsPanel.tsx`, `pages/PageView.tsx`, `pages/Settings.tsx`, `pages/TrashView.tsx`, `pages/tasks/BulkBar.tsx` |
| `type.svg` | Type | 18 | `editor/SlashMenu.tsx` |
| `underline.svg` | Underline | 16, css | `editor/NoteEditor.tsx`, `editor/Toolbar.tsx` |
| `undo-2.svg` | Undo2 | 18, css | `editor/Toolbar.tsx`, `pages/PageView.tsx` |
| `upload.svg` | Upload | 15, css | `components/WorkspaceData.tsx`, `components/shell/SectionRibbons.tsx` |
| `user.svg` | User | 16, css | `components/shell/SectionRibbons.tsx`, `pages/Settings.tsx` |
| `user-minus.svg` | UserMinus | 16 | `components/sharing/MembersPanel.tsx` |
| `user-plus.svg` | UserPlus | 14, 15, via prop | `components/sharing/NotificationBell.tsx`, `components/shell/notesRows.tsx`, `pages/PageView.tsx` |
| `user-round.svg` | UserRound | 13, 15 | `components/QuickAdd.tsx`, `components/TaskControls.tsx`, `components/TaskDetail.tsx`, `pages/tasks/BulkBar.tsx` |
| `users.svg` | Users | 11, 12, 13, 15, 16, 22, css | `components/Labels.tsx`, `components/QuickAdd.tsx`, `components/TaskDetail.tsx`, `components/TeamsSettings.tsx`, `components/sharing/SharedWithMe.tsx`, `components/shell/SectionRibbons.tsx`, `components/shell/TasksPanel.tsx`, `components/shell/commands.tsx`, `pages/PageView.tsx`, `pages/Settings.tsx`, `pages/tasks/AllView.tsx` |
| `users-round.svg` | UsersRound | 16, css | `components/shell/SectionRibbons.tsx`, `pages/Settings.tsx` |
| `x.svg` | X | 11, 12, 13, 14, 15, 16, 18 (stroke 3) | `components/Overlays.tsx`, `components/TaskDetail.tsx`, `components/notifications/RecurrencePicker.tsx`, `components/sharing/PageShareDialog.tsx`, `components/sharing/SharedWithMe.tsx`, `components/ui.tsx`, `pages/tasks/BulkBar.tsx`, `pages/tasks/FilterChips.tsx` |
