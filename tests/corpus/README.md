# Page-format corpus

Real page documents built by today's TS code, with what today's code says about them. The TS
implementation (`tests/corpus.test.ts`) and the Rust one (`crates/nv-model/tests/corpus.rs`) must
both reproduce every expectation from the committed `page.bin` files. It is the contract for the
page format during the native rewrite (`docs/ARCHITECTURE.md` section 4).

Regenerate after an intended change to the format or to one of the readers below, and commit
the diff (review it: a changed expectation is a behaviour change):

```sh
node --import tsx scripts/corpus/generate.ts
```

The cases are defined in `scripts/corpus/cases.ts`: block content goes through the editor's
schema (`scripts/corpus/schema.ts`, a mirror of `documentExtensions()` in
`src/editor/NoteEditor.tsx`) and y-prosemirror's conversion, so it is stored exactly as the live
editor stores it. Add a case when the editor gains a block, mark or attribute.

## Files

`list-markers.json`: `listMarker(type, n)` for every list type over a range of numbers, and
`listSuffix(paren)` (`shared/listMarker.ts`).

`cases/<name>/`:

| File | What | From |
|---|---|---|
| `page.bin` | The page's Y.Doc, `Y.encodeStateAsUpdate` (client id 1). | `scripts/corpus/cases.ts` |
| `input.json` | `about`, the page `title`, and `tasks`: what the task lookup returns per id (`null` = leave the task and its notes out; ids not listed are unknown: notes shown, no task line). | the case |
| `page.md` | `toMarkdown(title, pageFragments(doc), lookup)` | `server/markdown.ts` |
| `page.txt` | The searchable text (`extractPage(doc).text`, what goes into `pages_fts` via `searchableText`). | `server/collab.ts` |
| `expected.json` | Everything else, below. | |

`expected.json` keys:

- `kind`, `formatVersion`, `newerFormat`, `pageSettings`: `docKind`, `pageFormatVersion`, `isNewerPageFormat`, `readPageSettings` (`shared/pageDoc.ts`).
- `boxes`: `boxGeoms(doc)` sorted by id (defaults applied: x 0, y 0, w 400, z 0; `wide` only when true).
- `readingOrder`: box ids by `readingOrder` (y, then x, then id). `mainFragment`: the root name of `mainFragment(doc)`.
- `fragments`: `pageFragments(doc)` as `{ name, content }`, `default` first. Each node is
  `{ type, attrs, content }` (an `XmlElement`: its name, every attribute, its children) or
  `{ text: [{ insert, attributes? }] }` (an `XmlText`'s delta; marks are its attributes, stored by
  y-prosemirror as `{ bold: {} }`, `{ link: { href, … } }`, and `comment--<hash>` for marks that may
  overlap). Anything else in a fragment is `{ other: true }`.
- `headings`: `pageHeadings(doc)`.
- `ink`: `pageInk(doc)` as `{ id, bytes }` (base64).
- `taskIds`, `mentionIds`: from `extractPage(doc)`, sorted.
- `orderedLists`: every `orderedList` (fragments in reading order, depth first) with its fragment,
  child-index `path` from the fragment, `xmlListStart`, and each item's marker
  (`listMarker(type, start + i) + listSuffix(paren)`), as Markdown numbers it.
- `sanitized`: after `sanitizeYDoc(doc)` (`server/sanitizeDoc.ts`): `removed` (its return value),
  the `fragments` again, `ink` (valid stroke ids) and `inkKeys` (every key left in `ink`).

Files here are compared byte for byte (`.gitattributes`: no line-ending conversion).
