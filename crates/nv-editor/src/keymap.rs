//! Keys to commands (EDITOR.md 4), in today's order of precedence. Chords are written as in the
//! editor suite: `Mod+b`, `Shift+Tab`, `Mod+Alt+2`, `Alt+Shift+ArrowUp` (`Mod` is Ctrl, or Cmd on Apple).

use crate::editor::Editor;
use crate::schema::Attrs;

/// A chord, normalised: modifiers sorted, the key last.
pub fn normalize(chord: &str) -> String {
    let parts: Vec<&str> = chord.split('+').collect();
    let (mods, key) = parts.split_at(parts.len() - 1);
    let mut mods: Vec<String> = mods
        .iter()
        .map(|m| match m.to_ascii_lowercase().as_str() {
            "ctrl" | "cmd" | "meta" | "mod" | "controlormeta" => "Mod".to_string(),
            "alt" | "option" => "Alt".to_string(),
            "shift" => "Shift".to_string(),
            other => other.to_string(),
        })
        .collect();
    mods.sort();
    let key = key[0];
    let key = if key.chars().count() == 1 {
        key.to_ascii_lowercase()
    } else {
        key.to_string()
    };
    mods.push(key);
    mods.join("+")
}

impl Editor {
    /// Handle a key chord. Returns whether it did anything (unhandled keys are the view's: Tab to the next box).
    pub fn key(&mut self, chord: &str) -> bool {
        let handled = match normalize(chord).as_str() {
            "Enter" => self.enter(),
            "Shift+Enter" => self.hard_break(),
            "Backspace" => self.backspace(),
            "Delete" => self.delete_forward(),
            "Tab" => self.tab(),
            "Shift+Tab" => self.shift_tab(),
            "Mod+b" => self.toggle_mark("bold"),
            "Mod+i" => self.toggle_mark("italic"),
            "Mod+u" => self.toggle_mark("underline"),
            "Mod+Shift+s" => self.toggle_mark("strike"),
            "Mod+e" => self.toggle_mark("code"),
            "Alt+Mod+0" => self.set_block_type("paragraph", Attrs::new()),
            "Alt+Mod+1" => self.toggle_heading(1),
            "Alt+Mod+2" => self.toggle_heading(2),
            "Alt+Mod+3" => self.toggle_heading(3),
            "Mod+." => self.toggle_list("bulletList"),
            "Mod+Shift+8" => self.toggle_list("bulletList"),
            "Mod+Shift+7" => self.toggle_list("orderedList"),
            "Mod+Shift+b" => self.toggle_wrap("blockquote"),
            "Alt+Mod+c" => self.toggle_code_block(),
            "Alt+Shift+ArrowUp" => self.move_block(true),
            "Alt+Shift+ArrowDown" => self.move_block(false),
            "Mod+a" => self.select_all(),
            _ => false,
        };
        self.finish();
        handled
    }

    /// Tab: list nesting (in a list it's always the list's, even with nothing to nest under).
    pub fn tab(&mut self) -> bool {
        if self.list_item_depth().is_some() {
            self.indent();
            return true;
        }
        false
    }

    pub fn shift_tab(&mut self) -> bool {
        if self.list_item_depth().is_some() {
            self.outdent();
            return true;
        }
        false
    }
}
