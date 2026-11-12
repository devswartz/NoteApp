//! macOS spell checking for the editor. WKWebView reads its text-checking
//! switches from the app's NSUserDefaults (the same keys Safari uses), and in an
//! app that has never set them continuous spell checking is off, so the
//! editor's `spellcheck="true"` never underlined anything. Safari turns these
//! on for itself; a Tauri app has to register them before the first webview.
//!
//! They're registered as defaults, not written: once someone flips "Check
//! Spelling While Typing" or a Substitutions item in the editor's right-click
//! menu, WebKit stores that choice and it wins on the next launch.
//! Autocorrect and text replacement start from the system's own settings
//! (System Settings > Keyboard > Text Input), as in Notes or TextEdit. Smart
//! quotes/dashes and grammar stay off: they'd fight the editor's Markdown-style
//! shortcuts and code blocks.

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::NSSpellChecker;
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

pub fn register_defaults() {
    #[allow(unused_unsafe)]
    let (correct, replace) = unsafe {
        (
            NSSpellChecker::isAutomaticSpellingCorrectionEnabled(),
            NSSpellChecker::isAutomaticTextReplacementEnabled(),
        )
    };
    let entries: [(&str, bool); 3] = [
        ("WebContinuousSpellCheckingEnabled", true),
        ("WebAutomaticSpellingCorrectionEnabled", correct),
        ("WebAutomaticTextReplacementEnabled", replace),
    ];
    let keys: Vec<Retained<NSString>> = entries.iter().map(|(k, _)| NSString::from_str(k)).collect();
    let values: Vec<Retained<NSNumber>> = entries.iter().map(|(_, v)| NSNumber::new_bool(*v)).collect();
    let key_refs: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let value_refs: Vec<&AnyObject> = values.iter().map(|v| v.as_ref()).collect();
    let dict = NSDictionary::from_slices(&key_refs, &value_refs);
    #[allow(unused_unsafe)]
    unsafe {
        NSUserDefaults::standardUserDefaults().registerDefaults(&dict);
    }
}
