# Tests

Run with `npm test` (Node 20+, no dependencies).

- `lib/load-plugin.mjs`: evaluates `plugin.js` with a stub `AppPlugin` so methods can be called outside Thymer.
- `lib/fs-handle.mjs`: a File System Access API stand-in (`dirHandle(path)`) backed by a real folder, for code written against `showDirectoryPicker()`.

## Fixtures

- `fixtures/<source>/`: small **synthetic** fixtures, committed. They mirror the real export structure but contain made-up content.
- Real exports are **never committed**. Tests that use them read a path from an env var and skip when it's unset:
  - `TOLARIA_VAULT`: a Tolaria vault folder
  - `NOTION_EXPORT`: an unzipped Notion "Markdown & CSV" export folder
- `fixtures/private/` is gitignored for local copies or symlinks.
