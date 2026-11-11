# Tests

Run with `npm test` (Node 20+, no dependencies).

- `lib/load-plugin.mjs`: evaluates `plugin.js` with a stub `AppPlugin` so methods can be called outside Thymer.
- `lib/fake-thymer.mjs`: an in-memory Thymer data API (collections, records, properties, line items, blobs) whose signatures follow the SDK's `types.d.ts`. It backs the `applyImportPlan()` tests. It is strict about the things the types pin down (e.g. `ref` segments must be `{ guid }`, a record property needs an existing GUID, items with children can't be deleted) but it is **not** Thymer: its `insertFromMarkdown` only splits lines into text/heading/list/task items.
- `lib/fs-handle.mjs`: a File System Access API stand-in (`dirHandle(path)`) backed by a real folder, for code written against `showDirectoryPicker()`.

## Test files

- `smoke.test.mjs`: plugin loads, CSV parsing.
- `link-index.test.mjs`: `LinkIndex` alias resolution (path, slug, Notion id, title, ambiguity).
- `engine.test.mjs`: `applyImportPlan()` against the fake (collections, dedupe, links, unresolved links, multi-value references, assets, journal, failure isolation).
- `tolaria.test.mjs`: `parseTolariaVault()` over `fixtures/tolaria` (plan snapshots, directory-handle and file-list input, parent-folder pick, idempotent re-import on the fake, dialog glue with a DOM stub).
- `tolaria-real.test.mjs`: the same parser + `applyImportPlan()` over a real vault; skipped unless `TOLARIA_VAULT` is set. Prints a count summary only.

## Fixtures

- `fixtures/<source>/`: small **synthetic** fixtures, committed. They mirror the real export structure but contain made-up content.
- Real exports are **never committed**. Tests that use them read a path from an env var and skip when it's unset:
  - `TOLARIA_VAULT`: a Tolaria vault folder
  - `NOTION_EXPORT`: an unzipped Notion "Markdown & CSV" export folder
- `fixtures/private/` is gitignored for local copies or symlinks.
