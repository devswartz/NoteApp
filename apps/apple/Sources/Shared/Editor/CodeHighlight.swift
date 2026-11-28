import Foundation

/// Syntax colours for code blocks: a small tokenizer for the languages the web's block menu offers
/// (src/editor/blocks.tsx CODE_LANGUAGES, highlighted there by lowlight), coloured as the web's `.hljs-*` rules
/// (src/styles/editor.css). A block with no language is left plain (the web auto-detects; this does not guess).
enum CodeHighlight {
    enum Kind { case comment, keyword, string, number, title, attr, type, meta, deletion, addition }

    struct Span {
        let range: NSRange
        let kind: Kind
    }

    static func color(_ k: Kind, dark: Bool) -> PlatformColor {
        let pair: (UInt32, UInt32)
        switch k {
        case .comment: pair = (0x8B8B94, 0x8B8B94)
        case .keyword: pair = (0x7C3AED, 0xC4B5FD)
        case .string, .addition: pair = (0x15803D, 0x86EFAC)
        case .number: pair = (0xC2410C, 0xFDBA74)
        case .title: pair = (0x2563EB, 0x93C5FD)
        case .attr: pair = (0x0E7490, 0x67E8F9)
        case .type: pair = (0xB45309, 0xFCD34D)
        case .meta: pair = (0xBE185D, 0xF9A8D4)
        case .deletion: pair = (0xDC2626, 0xFCA5A5)
        }
        return PlatformColor(hex: dark ? pair.1 : pair.0)
    }

    /// Colour the text of a code block in place.
    static func apply(_ s: NSMutableAttributedString, language: String?, dark: Bool) {
        guard let language, !language.isEmpty, s.length > 0, s.length < 40_000 else { return }
        for span in spans(s.string, language: language) where NSMaxRange(span.range) <= s.length {
            s.addAttribute(.foregroundColor, value: color(span.kind, dark: dark), range: span.range)
        }
    }

    // MARK: Languages

    private struct Lang {
        var line: [String] = []
        var block: (String, String)?
        var quotes: [UInt16] = [34, 39]
        var keywords: Set<String> = []
        var literals: Set<String> = []
        var types: Set<String> = []
        var ignoreCase = false
        var calls = true
        var dollarVars = false
        var capitalisedTypes = false
    }

    private static func words(_ s: String) -> Set<String> { Set(s.split(separator: " ").map(String.init)) }

    private static let clike = words("if else for while do switch case break continue return default goto sizeof static const extern volatile struct union enum typedef new delete this class public private protected virtual override final namespace using template typename try catch throw throws import package interface extends implements abstract void in is as async await yield function var let get set from export fun val when object companion data sealed inline lateinit suspend internal operator readonly declare type module")
    private static let typeWords = words("int long short char float double bool boolean byte unsigned signed string String Int Long Double Float Bool Boolean Char Byte any number object unknown never u8 u16 u32 u64 usize i8 i16 i32 i64 isize f32 f64 str Self")
    private static let lits = words("true false null nil None True False undefined NaN Infinity")

    private static func lang(_ name: String) -> Lang? {
        var l = Lang()
        switch name {
        case "c", "cpp", "csharp", "java", "kotlin", "go", "javascript", "typescript", "swift", "rust", "php", "graphql":
            l.line = ["//"]
            l.block = ("/*", "*/")
            l.keywords = clike
            l.literals = lits
            l.types = typeWords
            l.capitalisedTypes = true
            if ["javascript", "typescript", "kotlin", "swift", "go"].contains(name) { l.quotes = [34, 39, 96] }
            if name == "php" { l.line = ["//", "#"]; l.dollarVars = true }
            if name == "graphql" {
                l.line = ["#"]
                l.block = nil
                l.keywords = words("query mutation subscription fragment on type input enum interface union scalar schema extend directive implements")
            }
            if name == "rust" { l.keywords.formUnion(words("fn let mut pub impl trait mod use crate match loop where move ref dyn unsafe")) }
            if name == "go" { l.keywords.formUnion(words("func package chan map range defer go select fallthrough")) }
            if name == "swift" { l.keywords.formUnion(words("func let var guard init deinit extension protocol subscript where some any weak lazy mutating")) }
            if name == "csharp" || name == "java" { l.keywords.formUnion(words("decimal sealed lock out ref params foreach")) }
            return l
        case "python":
            l.line = ["#"]
            l.keywords = words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case")
            l.literals = lits
            l.types = words("int str float bool list dict set tuple bytes object self cls print len range")
            return l
        case "ruby":
            l.line = ["#"]
            l.keywords = words("alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require include attr_accessor")
            l.literals = lits
            return l
        case "bash":
            l.line = ["#"]
            l.quotes = [34, 39, 96]
            l.keywords = words("if then else elif fi for while until do done case esac in function select return exit local export readonly source alias unset set shift break continue")
            l.types = words("echo cd ls cat grep sed awk curl rm cp mv mkdir chmod chown sudo git npm pip printf test read")
            l.dollarVars = true
            l.calls = false
            return l
        case "sql":
            l.line = ["--"]
            l.block = ("/*", "*/")
            l.ignoreCase = true
            l.keywords = words("select from where and or not insert into values update set delete create table alter drop index view join inner left right outer full cross on as group by order having limit offset union all distinct case when then else end is in like between exists primary key foreign references default unique constraint with returning asc desc begin commit rollback")
            l.literals = words("true false null")
            l.types = words("int integer bigint smallint text varchar char boolean bool date time timestamp timestamptz numeric decimal float double real json jsonb uuid serial")
            return l
        case "yaml":
            l.line = ["#"]
            l.literals = words("true false null yes no on off")
            l.calls = false
            return l
        case "json":
            l.literals = words("true false null")
            l.quotes = [34]
            l.calls = false
            return l
        case "css":
            l.block = ("/*", "*/")
            return l
        default:
            return nil
        }
    }

    // MARK: Scanner

    static func spans(_ text: String, language: String) -> [Span] {
        switch language {
        case "plaintext": return []
        case "diff": return diff(text)
        case "markdown": return markdown(text)
        case "xml": return xml(text)
        default: break
        }
        guard let lang = lang(language) else { return [] }
        let u = Array(text.utf16)
        let n = u.count
        var out: [Span] = []
        var i = 0
        let isJSON = language == "json", isYAML = language == "yaml", isCSS = language == "css"

        func at(_ s: String, _ pos: Int) -> Bool {
            let w = Array(s.utf16)
            guard pos + w.count <= n else { return false }
            for k in 0..<w.count where u[pos + k] != w[k] { return false }
            return true
        }
        func isIdentStart(_ c: UInt16) -> Bool { (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c == 36 || c > 127 }
        func isDigit(_ c: UInt16) -> Bool { c >= 48 && c <= 57 }
        func isIdent(_ c: UInt16) -> Bool { isIdentStart(c) || isDigit(c) || (isCSS && c == 45) }
        func nextNonSpace(_ from: Int) -> UInt16? {
            var j = from
            while j < n, u[j] == 32 || u[j] == 9 { j += 1 }
            return j < n ? u[j] : nil
        }

        while i < n {
            let c = u[i]
            // Comments.
            if let b = lang.block, at(b.0, i) {
                var j = i + b.0.utf16.count
                while j < n, !at(b.1, j) { j += 1 }
                j = min(n, j + b.1.utf16.count)
                out.append(Span(range: NSRange(location: i, length: j - i), kind: .comment))
                i = j
                continue
            }
            if let p = lang.line.first(where: { at($0, i) }) {
                // A # inside a word isn't a comment.
                if p == "#" && i > 0 && isIdent(u[i - 1]) { i += 1; continue }
                var j = i
                while j < n, u[j] != 10 { j += 1 }
                out.append(Span(range: NSRange(location: i, length: j - i), kind: .comment))
                i = j
                continue
            }
            // Strings.
            if lang.quotes.contains(c) {
                var j = i + 1
                while j < n, u[j] != c, c == 96 || u[j] != 10 {
                    if u[j] == 92, j + 1 < n { j += 1 }
                    j += 1
                }
                j = min(n, j + 1)
                let key = (isJSON || isYAML) && nextNonSpace(j) == 58
                out.append(Span(range: NSRange(location: i, length: j - i), kind: key ? .attr : .string))
                i = j
                continue
            }
            // Numbers (and CSS hex colours).
            let startsNumber = isDigit(c) && (i == 0 || !isIdent(u[i - 1]))
            let cssColor = isCSS && c == 35 && cssHex(u, i)
            if startsNumber || cssColor {
                var j = i + 1
                while j < n, isIdent(u[j]) || u[j] == 46 || (isCSS && u[j] == 37) { j += 1 }
                out.append(Span(range: NSRange(location: i, length: j - i), kind: .number))
                i = j
                continue
            }
            // $variables.
            if lang.dollarVars, c == 36, i + 1 < n, isIdentStart(u[i + 1]) || u[i + 1] == 123 {
                var j = i + 1
                if u[j] == 123 {
                    while j < n, u[j] != 125 { j += 1 }
                    j = min(n, j + 1)
                } else {
                    while j < n, isIdent(u[j]) { j += 1 }
                }
                out.append(Span(range: NSRange(location: i, length: j - i), kind: .attr))
                i = j
                continue
            }
            // CSS at-rules.
            if isCSS, c == 64 {
                var j = i + 1
                while j < n, isIdent(u[j]) { j += 1 }
                out.append(Span(range: NSRange(location: i, length: j - i), kind: .keyword))
                i = j
                continue
            }
            // Words.
            if isIdentStart(c) {
                var j = i + 1
                while j < n, isIdent(u[j]) { j += 1 }
                let word = String(decoding: u[i..<j], as: UTF16.self)
                let key = lang.ignoreCase ? word.lowercased() : word
                let after = nextNonSpace(j)
                var kind: Kind?
                if isCSS {
                    if after == 58 { kind = .attr } else if i > 0, u[i - 1] == 46 || u[i - 1] == 35 { kind = .title }
                } else if isYAML {
                    if after == 58 { kind = .attr } else if lang.literals.contains(key) { kind = .keyword }
                } else if lang.keywords.contains(key) || lang.literals.contains(key) {
                    kind = .keyword
                } else if lang.types.contains(key) {
                    kind = .type
                } else if lang.capitalisedTypes, let f = word.unicodeScalars.first, CharacterSet.uppercaseLetters.contains(f), word.count > 1, word != word.uppercased() {
                    kind = .type
                } else if lang.calls, after == 40 {
                    kind = .title
                }
                if let kind { out.append(Span(range: NSRange(location: i, length: j - i), kind: kind)) }
                i = j
                continue
            }
            i += 1
        }
        return out
    }

    private static func cssHex(_ u: [UInt16], _ i: Int) -> Bool {
        var j = i + 1, count = 0
        while j < u.count, (u[j] >= 48 && u[j] <= 57) || (u[j] >= 97 && u[j] <= 102) || (u[j] >= 65 && u[j] <= 70) {
            j += 1
            count += 1
        }
        return [3, 4, 6, 8].contains(count)
    }

    private static func lines(_ text: String) -> [(Int, String)] {
        var out: [(Int, String)] = []
        var loc = 0
        for line in text.components(separatedBy: "\n") {
            out.append((loc, line))
            loc += (line as NSString).length + 1
        }
        return out
    }

    private static func diff(_ text: String) -> [Span] {
        var out: [Span] = []
        for (loc, line) in lines(text) where !line.isEmpty {
            let r = NSRange(location: loc, length: (line as NSString).length)
            if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("@@") {
                out.append(Span(range: r, kind: .meta))
            } else if line.hasPrefix("+") {
                out.append(Span(range: r, kind: .addition))
            } else if line.hasPrefix("-") {
                out.append(Span(range: r, kind: .deletion))
            }
        }
        return out
    }

    private static func markdown(_ text: String) -> [Span] {
        var out: [Span] = []
        for (loc, line) in lines(text) where !line.isEmpty {
            let ns = line as NSString
            let r = NSRange(location: loc, length: ns.length)
            if line.hasPrefix("#") {
                out.append(Span(range: r, kind: .title))
            } else if line.hasPrefix(">") {
                out.append(Span(range: r, kind: .comment))
            } else if line.hasPrefix("```") {
                out.append(Span(range: r, kind: .meta))
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                out.append(Span(range: NSRange(location: loc, length: 1), kind: .number))
            }
            // `code` spans.
            var from = 0
            while from < ns.length {
                let a = ns.range(of: "`", range: NSRange(location: from, length: ns.length - from))
                guard a.location != NSNotFound else { break }
                let b = ns.range(of: "`", range: NSRange(location: a.location + 1, length: ns.length - a.location - 1))
                guard b.location != NSNotFound else { break }
                out.append(Span(range: NSRange(location: loc + a.location, length: b.location - a.location + 1), kind: .string))
                from = b.location + 1
            }
        }
        return out
    }

    private static func xml(_ text: String) -> [Span] {
        var out: [Span] = []
        let u = Array(text.utf16)
        let n = u.count
        var i = 0
        func name(_ j: inout Int) {
            while j < n, (u[j] >= 65 && u[j] <= 90) || (u[j] >= 97 && u[j] <= 122) || (u[j] >= 48 && u[j] <= 58) || u[j] == 45 || u[j] == 95 || u[j] == 46 { j += 1 }
        }
        while i < n {
            guard u[i] == 60 else { i += 1; continue }
            if i + 3 < n, u[i + 1] == 33, u[i + 2] == 45, u[i + 3] == 45 {
                var j = i + 4
                while j + 2 < n, !(u[j] == 45 && u[j + 1] == 45 && u[j + 2] == 62) { j += 1 }
                j = min(n, j + 3)
                out.append(Span(range: NSRange(location: i, length: j - i), kind: .comment))
                i = j
                continue
            }
            var j = i + 1
            if j < n, u[j] == 47 || u[j] == 63 || u[j] == 33 { j += 1 }
            let s = j
            name(&j)
            if j > s { out.append(Span(range: NSRange(location: s, length: j - s), kind: .keyword)) }
            while j < n, u[j] != 62 {
                if u[j] == 34 || u[j] == 39 {
                    let q = u[j]
                    var k = j + 1
                    while k < n, u[k] != q { k += 1 }
                    k = min(n, k + 1)
                    out.append(Span(range: NSRange(location: j, length: k - j), kind: .string))
                    j = k
                } else if (u[j] >= 65 && u[j] <= 90) || (u[j] >= 97 && u[j] <= 122) {
                    let a = j
                    name(&j)
                    out.append(Span(range: NSRange(location: a, length: j - a), kind: .attr))
                } else {
                    j += 1
                }
            }
            i = j
        }
        return out
    }
}
