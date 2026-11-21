//! JavaScript semantics the TS page code relies on (truthiness, `Number()`, `String()`, `trim`,
//! UTF-16 string order), so the Rust readers give byte-identical results.

use std::cmp::Ordering;
use yrs::{Any, Number};

/// ECMAScript WhiteSpace and LineTerminator: what `trim()` and `\s` match.
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

pub fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_space)
}

/// A string's length as JS counts it (UTF-16 code units).
pub fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// `a < b` on JS strings: UTF-16 code unit order.
pub fn cmp_str(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `s.replace(/\n{3,}/g, '\n\n')`.
pub fn collapse_newlines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = 0;
    for c in s.chars() {
        if c == '\n' {
            run += 1;
            if run <= 2 {
                out.push('\n');
            }
        } else {
            run = 0;
            out.push(c);
        }
    }
    out
}

pub fn number(n: &Number) -> f64 {
    match n {
        Number::Int(i) => *i as f64,
        Number::Float(f) => *f,
    }
}

/// `typeof v === 'number'` (finite or not).
pub fn as_number(v: Option<&Any>) -> Option<f64> {
    match v {
        Some(Any::Number(n)) => Some(number(n)),
        _ => None,
    }
}

/// JS truthiness of a value (`None` is `undefined`).
pub fn truthy(v: Option<&Any>) -> bool {
    match v {
        None | Some(Any::Null) | Some(Any::Undefined) => false,
        Some(Any::Bool(b)) => *b,
        Some(Any::Number(n)) => {
            let f = number(n);
            f != 0.0 && !f.is_nan()
        }
        Some(Any::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `Number(v)`.
pub fn to_number(v: Option<&Any>) -> f64 {
    match v {
        None | Some(Any::Undefined) => f64::NAN,
        Some(Any::Null) => 0.0,
        Some(Any::Bool(b)) => f64::from(u8::from(*b)),
        Some(Any::Number(n)) => number(n),
        Some(Any::String(s)) => {
            let t = trim(s);
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>()
                    .ok()
                    .filter(|_| !t.contains(['i', 'n', 'N', 'I']))
                    .unwrap_or(f64::NAN)
            }
        }
        Some(Any::Array(a)) if a.is_empty() => 0.0,
        Some(_) => f64::NAN,
    }
}

/// `Number(v) || 1`.
pub fn number_or_one(v: Option<&Any>) -> f64 {
    let n = to_number(v);
    if n == 0.0 || n.is_nan() {
        1.0
    } else {
        n
    }
}

/// `String(n)` for a number.
pub fn number_string(f: f64) -> String {
    if f.is_nan() {
        "NaN".into()
    } else if f.is_infinite() {
        if f > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if f == f.trunc() && f.abs() < 1e21 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

/// `String(v)` / template-literal interpolation (`None` is `undefined`).
pub fn to_string(v: Option<&Any>) -> String {
    match v {
        None | Some(Any::Undefined) => "undefined".into(),
        Some(Any::Null) => "null".into(),
        Some(Any::Bool(b)) => b.to_string(),
        Some(Any::Number(n)) => number_string(number(n)),
        Some(Any::String(s)) => s.to_string(),
        Some(Any::Array(a)) => a
            .iter()
            .map(|x| match x {
                Any::Null | Any::Undefined => String::new(),
                x => to_string(Some(x)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Any::Map(_)) => "[object Object]".into(),
        Some(Any::Buffer(b)) => b
            .iter()
            .map(|x| x.to_string())
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// `v ?? ''` then `String()`.
pub fn string_or_empty(v: Option<&Any>) -> String {
    match v {
        None | Some(Any::Null) | Some(Any::Undefined) => String::new(),
        v => to_string(v),
    }
}

/// `(v as { [k]?: unknown } | null)?.[k]`: a field of an object value.
pub fn field<'a>(v: Option<&'a Any>, k: &str) -> Option<&'a Any> {
    match v {
        Some(Any::Map(m)) => m.get(k),
        _ => None,
    }
}
