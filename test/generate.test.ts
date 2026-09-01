import { test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { buildFixture, type Fixture } from "./fixture";

const GENERATE = join(import.meta.dir, "..", "generate.ts");

let fx: Fixture;
let html = "";
let stdout = "";
let DATA: {
  ranges: { file: number | null; lines: number[]; b?: number[]; all?: boolean }[][];
  titles: string[]; annKeys: string[]; filePaths: string[]; fileHashes: string[];
  storeKey: string; symbols: Record<string, unknown[]>;
};

beforeAll(async () => {
  fx = await buildFixture();
  const out = join(fx.repo, "review", "deep", "review.html"); // parent dirs must be created
  // Run from a subdirectory on purpose: paths must stay repo-root-relative.
  const proc = Bun.spawnSync(["bun", GENERATE, "main", "HEAD", "--annotations", fx.annotationsFile, "--out", out],
    { cwd: join(fx.repo, "src"), stdout: "pipe", stderr: "pipe" });
  stdout = proc.stdout.toString() + proc.stderr.toString();
  expect(proc.exitCode).toBe(0);
  html = await Bun.file(out).text();
  const dataLine = html.split("\n").find(l => l.startsWith("const DATA = "))!;
  DATA = JSON.parse(dataLine.slice("const DATA = ".length, -1));
});

// --- diff parsing ---

test("deleted '-- ' lines are content, not file headers", () => {
  expect(html).toContain("-- legacy path"); // the row survives, numbering intact
  expect(stdout).not.toContain("failed to resolve");
});

test("no phantom trailing context row", () => {
  expect(html).not.toMatch(/<td class="n">0<\/td>/);
});

test("non-ASCII paths come through verbatim", () => {
  expect(html).toContain("café.txt");
  expect(html).not.toContain("caf\\303");
});

test("every file gets a real blob hash (index lines + rev-parse fallback)", () => {
  for (const h of DATA.fileHashes) expect(h).toMatch(/^[0-9a-f]{40,64}$/);
});

// --- annotations parsing ---

test("preamble scope note renders as a general card", () => {
  expect(html).toMatch(/<h3>Scope<\/h3>/);
  expect(html).toContain("replaces the legacy path end to end");
});

test("code fences neither split sections nor contribute anchors", () => {
  expect(html).not.toContain("<h3>Fake heading inside fence</h3>");
  expect(html).toContain("[fake anchor](src/app.sql:1-2@"); // rendered as code, not a link
});

test("scoped-package (@ in path) anchors parse and resolve", () => {
  const scoped = DATA.ranges.flat().find(r => r.file === DATA.filePaths.indexOf("packages/@scope/pkg/index.ts"));
  expect(scoped).toBeDefined();
  expect(scoped!.lines.length).toBeGreaterThan(0);
});

test("claim letters are continuous across wraps, nesting, and fences", () => {
  expect(html).toContain('<li data-claim="a"');
  expect(html).toContain('<li data-claim="d"'); // the café bullet, after fence + nested list
  expect(html).toMatch(/>1d</); // and the matching gutter badge
});

// --- resolution ---

test("anchors at an old sha land on deleted rows", () => {
  const legacyIdx = DATA.filePaths.indexOf("src/legacy.ts");
  expect(legacyIdx).toBeGreaterThanOrEqual(0);
  expect(DATA.ranges.flat().some(r => r.file === legacyIdx && (r.b?.length ?? 0) > 0)).toBe(true);
  expect(html).toMatch(/<tr class="del(?: unc)?" id="D-\d+-\d+" data-anns=/);
});

test("out-of-range anchors drift positively and warn", () => {
  expect(stdout).toContain("range starts past end of file");
  expect(stdout).toContain("6 of 6 lines drifted");
});

test("mid-stack anchors drift when later commits rewrite their lines", () => {
  // Anchored at commit 1 to a line commit 1 added and commit 2 rewrote:
  // no image at head, none at merge-base — that's drift.
  expect(stdout).toMatch(/src\/app\.sql:3@\w+ .*1 of 1 lines drifted/);
});

test("anchors to files outside the diff warn and render dead", () => {
  expect(stdout).toContain("resolves to a file not in this diff");
  expect(html).toContain('class="iref dead"');
});

test("anchors to unrendered context warn and render distinctly", () => {
  expect(stdout).toContain("lines fall outside the diff's rendered hunks");
  expect(html).toContain('class="iref nsd"');
});

// --- overlapping annotations ---

test("overlapping annotations all render, with stripes and badges", () => {
  const row = html.match(/<tr [^>]*data-anns="(\d+) (\d+)"[^>]*>[\s\S]*?<\/tr>/);
  expect(row).not.toBeNull();
  expect(row![0]).toContain("inset 6px"); // second stripe band
  const badgeAnns = [...html.matchAll(/<button class="mark" data-ann="(\d+)"/g)].map(m => m[1]);
  expect(badgeAnns).toContain(row![1]!);
  expect(badgeAnns).toContain(row![2]!);
});

// --- coverage ---

test("hunkless files count as coverage units, covered by whole-file anchors", () => {
  expect(html).not.toContain('<div class="note unc">Binary file</div>'); // logo.bin is annotated
  const m = stdout.match(/coverage (\d+)\/(\d+)/)!;
  expect(+m[2]!).toBeGreaterThan(0);
});

// --- rendering ---

test("intraline word-level marks on paired changed lines", () => {
  expect(html).toContain('<mark class="ind">');
  expect(html).toContain('<mark class="ina">');
});

test("inline DATA cannot terminate the script tag", () => {
  const dataLine = html.split("\n").find(l => l.startsWith("const DATA = "))!;
  expect(dataLine).toContain("\\u003c/script"); // the </script> in a title, escaped
  expect(dataLine).not.toContain("</script");
});

test("symbol index survives Object.prototype names and stays linked-only", () => {
  expect(Array.isArray(DATA.symbols["toString"])).toBe(true);
  expect("beyond1" in DATA.symbols).toBe(false); // defined but never linked in a rendered row
});

test("reviewed-state key and annotation identities are stable", () => {
  expect(DATA.storeKey).toBe("annotated-review:main...HEAD");
  expect(DATA.annKeys.length).toBe(DATA.titles.length);
  for (const k of DATA.annKeys) expect(k).toMatch(/^[0-9a-z]+$/);
});
