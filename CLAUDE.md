# Development notes

Everything runs on Bun, not Node: `bun <file>`, `bun test`, `bun install`,
`bunx <package>`. See README.md for what the tool is; the CLI contract,
annotations format, and viewer semantics live in docs/REFERENCE.md — keep
that file in sync when changing behavior.

Layout: `generate.ts` is the whole generator (CLI, PR fetching, diff parsing,
anchor resolution, rendering); `viewer.css` / `viewer.js` are inlined into
the generated page; tests live in `test/` (`bunfig.toml` scopes `bun test`
there so the cached clones under `repos/` don't leak their own suites in).

## Verifying changes to the tool

Don't skip verifying a change just because it looks obviously right in the
source.

1. `bunx tsc --noEmit` — types.
2. `bun test` — builds a fixture repo covering the parser/resolver/renderer
   edge cases and boots the generated page in happy-dom to drive the viewer
   (badges, focus, persistence, broken-localStorage survival).
3. Regenerate a real PR page and read the CLI output: anchor warnings and the
   drift report are the tool telling you what broke.
4. Open the page in a browser: hover a bullet, click a badge, focus a card,
   toggle "Show uncovered", check a file and regenerate — the check must
   survive.
