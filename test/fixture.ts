/**
 * Builds a small git repository whose diff exercises the generator's edge
 * cases: deleted lines starting "-- " (diff header lookalikes), a deleted
 * file, a pure rename, a binary change, a non-ASCII filename, a scoped-package
 * path, Object.prototype-named definitions, an intraline-pair edit, and a
 * second commit so anchors written at the first can drift.
 */
import { $ } from "bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Fixture {
  repo: string;
  annotationsFile: string;
  baseSha: string;
  midSha: string;
  headSha: string;
}

export async function buildFixture(): Promise<Fixture> {
  const repo = mkdtempSync(join(tmpdir(), "pr-review-fixture-"));
  const git = (...args: string[]) => $`git -C ${repo} ${args}`.env({ ...process.env, GIT_TERMINAL_PROMPT: "0" }).quiet();
  const write = (path: string, content: string | Uint8Array) => Bun.write(join(repo, path), content);

  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@t");
  await git("config", "user.name", "t");

  await write("src/app.sql", [
    "SELECT 1;", "-- keep this comment", "-- legacy path", "SELECT legacy_thing();",
    "SELECT 2;", "SELECT 3;", "SELECT 4;", "SELECT tweak_me();", "SELECT 5;", "SELECT 6;", "",
  ].join("\n"));
  await write("src/util.ts", [
    "// util module",
    "export function helper(n: number) {", "  return n + 1;", "}", "",
    "const foo = bar(1);", "",
    "export function far() {", "  return 42;", "}", "",
    "export const tail = 1;", "export const anchorTarget = 2;",
    "export const beyond1 = 3;", "export const beyond2 = 4;", "export const beyond3 = 5;",
    "export const beyond4 = 6;", "export const beyond5 = 7;", "",
  ].join("\n"));
  await write("src/legacy.ts", [
    "// the legacy module",
    "export function legacyFetch() {", '  return fetch("/old");', "}",
    "export function legacyParse(x: string) {", "  return x.trim();", "}",
    "export const LEGACY = true;", "",
  ].join("\n"));
  await write("src/old-name.ts", "export const renamedThing = 1;\nexport const stableLine = 2;\n");
  await write("café.txt", "line 1\nline 2\nline 3\nline 4\nline 5\n");
  await write("logo.bin", new Uint8Array([66, 73, 78, 0, 1, 2, 79, 76, 68]));
  await write("README.md", "readme line 1\nreadme line 2\n");
  await write("packages/@scope/pkg/index.ts",
    ["// scoped pkg", ...Array.from({ length: 24 }, (_, i) => `export const v${i + 2} = ${i + 2};`), ""].join("\n"));
  await git("add", "-A");
  await git("commit", "-qm", "base");
  const baseSha = (await git("rev-parse", "HEAD")).stdout.toString().trim();

  await git("checkout", "-qb", "feature");
  // commit 1: "-- " deletions, delete a file, pure rename, binary swap,
  // scoped-package edit, a file defining toString/valueOf, non-ASCII edit
  const sql = (await Bun.file(join(repo, "src/app.sql")).text())
    .split("\n").filter(l => l !== "-- legacy path" && l !== "SELECT legacy_thing();")
    .map(l => (l === "SELECT 2;" ? "SELECT replacement();" : l)).join("\n");
  await write("src/app.sql", sql);
  await git("rm", "-q", "src/legacy.ts");
  await git("mv", "src/old-name.ts", "src/new-name.ts");
  await write("logo.bin", new Uint8Array([66, 73, 78, 0, 1, 2, 78, 69, 87]));
  const pkg = (await Bun.file(join(repo, "packages/@scope/pkg/index.ts")).text())
    .replace("export const v10 = 10;", "export const v10 = 100; // changed")
    .replace("export const v11 = 11;", "export const v11 = 110;")
    .replace("export const v12 = 12;", "export const v12 = 120;");
  await write("packages/@scope/pkg/index.ts", pkg);
  await write("src/proto.ts", [
    "export function toString(v: unknown) {", "  return String(v);", "}",
    "export function valueOf() {", "  return toString(1);", "}", "",
  ].join("\n"));
  await write("café.txt", "line 1\nline two\nline 3\nline 4\nline 5\n");
  await git("add", "-A");
  await git("commit", "-qm", "commit 1");
  const midSha = (await git("rev-parse", "HEAD")).stdout.toString().trim();

  // commit 2: touch a commit-1 line (so a mid-stack anchor on it has no image
  // on either diff side — true drift), plus an intraline pair in util.ts
  await write("src/app.sql", (await Bun.file(join(repo, "src/app.sql")).text())
    .replace("SELECT replacement();", "SELECT replacement(2);")
    .replace("SELECT tweak_me();", "SELECT tweaked();"));
  await write("src/util.ts", (await Bun.file(join(repo, "src/util.ts")).text())
    .replace("const foo = bar(1);", "const foo = baz(1, 2);"));
  await git("add", "-A");
  await git("commit", "-qm", "commit 2");
  const headSha = (await git("rev-parse", "HEAD")).stdout.toString().trim();

  const annotationsFile = join(repo, "annotations.md");
  await write("annotations.md", `Scope note: this PR replaces the legacy path end to end.

## Replace the legacy SQL path (aaa1111)

The legacy branch is gone: [the replacement call](src/app.sql:3-3@${headSha}) takes over.

- [The legacy comment and call are deleted](src/app.sql:3-4@${baseSha}) — both lines start with dashes.
- [The whole legacy module is removed](src/legacy.ts:2-7@${baseSha}), callers now use the new path. This bullet
  wraps across lines, and the continuation carries [a second anchor](src/app.sql:3-3@${midSha}) that drifts.
- Support files move too:
  - [old-name becomes new-name](src/new-name.ts@${headSha})
  - [the logo binary is swapped](logo.bin@${headSha})

Anchor syntax examples in fences must not count:

\`\`\`md
## Fake heading inside fence
[fake anchor](src/app.sql:1-2@${headSha})
\`\`\`

- After the fence, [café.txt line two changes](café.txt:2-2@${headSha}) — letters must continue, not restart.

## Scoped package tweak </script> (bbb2222)

Touches the scoped package: [the loader constants](packages/@scope/pkg/index.ts:10-12@${headSha}).

- [A dead anchor to an untouched file](README.md:1-2@${headSha}) should warn.
- [Context lines outside any hunk](src/util.ts:13-14@${headSha}) should warn as off-screen.
- [A range past the end of the file](src/util.ts:40-45@${headSha}) should drift.

## Broad sweep of util (ccc3333)

[Most of util.ts](src/util.ts:1-12@${headSha}) is context for the one-line change.

## Narrow overlap (ddd4444)

- [Just the changed call](src/util.ts:6-6@${headSha}) overlaps the broad sweep.
`);

  return { repo, annotationsFile, baseSha, midSha, headSha };
}
