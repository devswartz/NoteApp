//! Generates the Swift and Kotlin bindings from the built library:
//!   cargo run -p nv-core --features bindgen --bin uniffi-bindgen -- generate --library <lib> --language swift --out-dir <dir>
fn main() {
    uniffi::uniffi_bindgen_main()
}
