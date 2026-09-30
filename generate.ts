#!/usr/bin/env bun
/**
 * Annotated guide viewer generator.
 *
 * Reads an annotations file (author-side annotations with `path:start-end@commit`
 * line anchors and `path@commit` whole-file anchors) plus a git diff, and emits a
 * self-contained two-pane HTML page: diffs on the left in narrative order,
 * annotations on the right, linked both ways. Page styles and behavior live in
 * viewer.css / viewer.js and are inlined at build time.
 *
 * Pipeline: parse annotations → resolve anchors (line mapping via `git diff -U0`
 * between the anchor commit and both diff sides, so annotations survive later
 * commits, renames, and line shifts, and can point at deleted code) → parse diff
 * → materialize every anchor onto the diff's rows → count coverage → render.
 * Anchor lines modified after the annotation was written are surfaced as a
 * drift badge instead of pointing at the wrong code.
 *
 * Usage:
 *   bun generate.ts fetch <pr-url | owner/repo#N>
 *       Resolve a GitHub PR, clone/fetch it into repos/<owner>__<repo>, and
 *       print a JSON description (number, title, url, state, baseRefName,
 *       baseRefOid, headRefOid, owner, repo, cacheDir, localHeadRef).
 *   bun generate.ts --pr <pr-url | owner/repo#N> [--annotations <file>] [--out <file>]
 *       Fetch (as above) and generate the page for that PR in one step.
 *   bun generate.ts [base] [head] [--repo <dir>] [--annotations <file>] [--out <file>]
 *       Classic mode against a local repo (default: cwd; default base is
 *       origin/HEAD, else main/master; default head is HEAD).
 *   Defaults: annotations=review/annotations.md, out=review/review.html
 */

import { $ } from "bun";
import { join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { createHighlighter, type Highlighter } from "shiki";
import { marked, Renderer, type Token, type Tokens } from "marked";
import { diffWordsWithSpace } from "diff";

const TOOL_DIR = import.meta.dir;

// ---------- generic helpers ----------

/** Memoize by string key into a Map — shared shape for all the caches below.
 * Values may be Promises: concurrent callers share one in-flight computation. */
function cached<V>(map: Map<string, V>, key: string, fn: () => V): V {
  if (!map.has(key)) map.set(key, fn());
  return map.get(key)!;
}

/** Run fn over items with at most n in flight. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/** 0 -> "a", 25 -> "z", 26 -> "aa" — claim letters. */
function letterOf(i: number): string {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(97 + ((i - 1) % 26)) + s;
  return s;
}

// ---------- git helpers ----------

// The repository under review. Set once in main() (from --repo / --pr / cwd)
// and resolved to the repo's top level, so path output from git (always
// root-relative) matches the paths we pass back in.
let REPO = ".";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

async function gitIn(dir: string, args: string[]): Promise<string> {
  // quotepath off so non-ASCII paths come out verbatim, not octal-escaped.
  const r = await $`git -C ${dir} -c core.quotepath=false ${args}`.env(GIT_ENV).quiet().nothrow();
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim() || "(no stderr)"}`);
  return r.stdout.toString();
}

const git = (...args: string[]) => gitIn(REPO, args);

const contentCache = new Map<string, Promise<string | null>>();
const contentSync = new Map<string, string | null>(); // resolved mirror, for the sync render path

/** Content of path at sha, or null if it doesn't exist there. */
function fetchContent(sha: string, path: string): Promise<string | null> {
  return cached(contentCache, `${sha}:${path}`, async () => {
    const r = await $`git -C ${REPO} show ${`${sha}:${path}`}`.env(GIT_ENV).quiet().nothrow();
    const content = r.exitCode === 0 ? r.stdout.toString() : null;
    contentSync.set(`${sha}:${path}`, content);
    return content;
  });
}

const linesCache = new Map<string, string[] | null>();

/** Lines of path at sha — valid only after fetchContent(sha, path) resolved
 * (rendering prefetches every file version it reads). */
function linesOf(sha: string, path: string): string[] | null {
  return cached(linesCache, `${sha}:${path}`, () => {
    const content = contentSync.get(`${sha}:${path}`);
    if (content === undefined || content === null) return null;
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  });
}

function countLines(content: string): number {
  return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

const existsCache = new Map<string, Promise<boolean>>();

/** Does path exist at sha? (cat-file probe — no full-tree listing needed) */
function existsAt(sha: string, path: string): Promise<boolean> {
  return cached(existsCache, `${sha}:${path}`, async () => {
    const r = await $`git -C ${REPO} cat-file -e ${`${sha}:${path}`}`.env(GIT_ENV).quiet().nothrow();
    return r.exitCode === 0;
  });
}

// ---------- annotations ----------

interface Anchor { path: string; start: number; end: number; sha: string; wholeFile: boolean; bullet: number | null; }
interface ResolvedAnchor extends Anchor {
  fileIdx: number | null;      // diff file section this anchor binds to; null if unresolvable
  headLines: number[];         // anchor lines mapped to head line numbers
  baseLines: number[];         // anchor lines mapped to merge-base line numbers (covers deleted rows)
  drifted: number;             // anchor lines with no surviving image on either diff side
  rendered: number;            // diff rows this anchor actually tagged (set by materializeOntoRows)
  notes: string[];             // resolution warnings for the CLI report
}
interface Annotation {
  title: string;               // plain title text (tooltips, warnings, DATA)
  titleHtml: string;
  bodyTokens: Token[];         // marked tokens; anchor links carry _anchorIdx, list items _claim
  key: string;                 // content hash — stable identity for reviewed-state persistence
  anchors: Anchor[];
  resolved: ResolvedAnchor[];
}

// Custom stamps on marked tokens, set while walking the lexer output and read
// back by renderCard's renderer overrides — one walk is the single source of
// truth for both the anchors and the claim letters.
type AnchorToken = Tokens.Link & { _anchorIdx?: number };
type ClaimItem = Tokens.ListItem & { _claim?: string };

const anchorSpan = (a: Anchor) => a.wholeFile ? `${a.path}@${a.sha.slice(0, 9)}` : `${a.path}:${a.start}${a.end !== a.start ? "-" + a.end : ""}@${a.sha.slice(0, 9)}`;
const deadAnchor = (a: Anchor, note: string): ResolvedAnchor =>
  ({ ...a, fileIdx: null, headLines: [], baseLines: [], drifted: a.wholeFile ? 0 : a.end - a.start + 1, rendered: 0, notes: [note] });

// Anchors are markdown links binding a phrase of the body to code:
// [phrase](path:12-30@sha) anchors lines, [phrase](path@sha) the whole file
// (path and lines as of that commit). They render as clickable prose.
// Paths may contain "@" (scoped packages); the sha is the trailing "@hex".
function parseAnchorHref(href: string): Omit<Anchor, "bullet"> | null {
  if (href.includes("://")) return null;
  let m = href.match(/^(.+):(\d+)(?:-(\d+))?@([0-9a-fA-F]{6,64})$/);
  if (m) {
    const start = parseInt(m[2]!, 10);
    return { path: m[1]!, start, end: m[3] ? parseInt(m[3], 10) : start, sha: m[4]!, wholeFile: false };
  }
  // Whole-file form: no ":" in the path keeps schemes (mailto: etc.) out.
  m = href.match(/^([^:]+)@([0-9a-fA-F]{6,64})$/);
  if (m) return { path: m[1]!, start: 0, end: 0, sha: m[2]!, wholeFile: true };
  return null;
}

/**
 * Parse the annotations file with marked's lexer — headings inside code fences
 * don't split sections, and anchor-shaped text inside fences or codespans is
 * never a link token, so it can't be mistaken for a real anchor. Claim letters
 * are stamped onto the list-item tokens here and rendered from those stamps,
 * so gutter badges and card letters can't disagree.
 */
function parseAnnotations(src: string): Annotation[] {
  const tokens = marked.lexer(src);
  const links = (tokens as Token[] & { links: unknown }).links;

  const sections: { heading: Tokens.Heading | null; body: Token[] }[] = [{ heading: null, body: [] }];
  for (const t of tokens) {
    if (t.type === "heading" && (t as Tokens.Heading).depth === 2) sections.push({ heading: t as Tokens.Heading, body: [] });
    else sections.at(-1)!.body.push(t);
  }

  const out: Annotation[] = [];
  for (const sec of sections) {
    // Preamble before the first "##" is the scope note — keep it as a card.
    if (!sec.heading && !sec.body.some(t => t.type !== "space")) continue;
    const title = sec.heading?.text.trim() ?? "Scope";
    const anchors: Anchor[] = [];
    let letters = 0;

    // One recursive walk: letter top-level list items (nested items and later
    // lists continue the same sequence a, b, c…), and collect anchor links,
    // each tagged with the letter of the top-level bullet it sits in.
    const visit = (toks: Token[], bullet: number | null, top: boolean) => {
      for (const t of toks) {
        if (t.type === "list") {
          for (const item of (t as Tokens.List).items) {
            let b = bullet;
            if (top) { b = letters++; (item as ClaimItem)._claim = letterOf(b); }
            visit(item.tokens ?? [], b, false);
          }
          continue;
        }
        if (t.type === "link") {
          const a = parseAnchorHref((t as Tokens.Link).href);
          if (a) { (t as AnchorToken)._anchorIdx = anchors.length; anchors.push({ ...a, bullet }); }
        }
        if ("tokens" in t && t.tokens) visit(t.tokens, bullet, top);
      }
    };
    visit(sec.body, null, true);

    const bodyTokens: Token[] = Object.assign([...sec.body], { links });
    const raw = (sec.heading?.raw ?? "") + sec.body.map(t => t.raw).join("");
    out.push({
      title,
      titleHtml: sec.heading ? (marked.parseInline(sec.heading.text) as string) : title,
      bodyTokens,
      key: Bun.hash(raw).toString(36),
      anchors,
      resolved: [],
    });
  }
  return out;
}

// ---------- diff parsing ----------

type RowType = "ctx" | "add" | "del";
interface RowAnn { ai: number; claim: string; }
interface Row { type: RowType; oldNo: number | null; newNo: number | null; text: string; anns: RowAnn[]; marks?: [number, number][]; }
interface Hunk { header: string; rows: Row[]; }
interface DiffFile {
  oldPath: string | null; newPath: string | null; binary: boolean; hunks: Hunk[]; status: string;
  oldBlob: string | null; newBlob: string | null;  // from the index header (--full-index)
}

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let h: Hunk | null = null;
  let oldNo = 0, newNo = 0;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop(); // trailing newline, not an empty context row
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      f = { oldPath: null, newPath: null, binary: false, hunks: [], status: "modified", oldBlob: null, newBlob: null };
      // Binary files have no ---/+++ lines, so the header is their only path
      // source; the ---/+++ (and rename/new/deleted) handlers below override
      // it whenever they carry path or status information.
      const gm = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (gm) { f.oldPath = gm[1]!; f.newPath = gm[2]!; }
      files.push(f); h = null;
      continue;
    }
    if (!f) continue;
    // Header lines are only valid before the first hunk: inside a hunk, a
    // deleted "-- comment" line renders as "--- comment" and must stay content.
    if (h === null) {
      if (line.startsWith("Binary files ") || line === "GIT binary patch") { f.binary = true; continue; }
      if (line.startsWith("new file")) { f.status = "added"; f.oldPath = null; continue; }
      if (line.startsWith("deleted file")) { f.status = "deleted"; f.newPath = null; continue; }
      if (line.startsWith("rename from ")) { f.status = "renamed"; f.oldPath = line.slice(12); continue; }
      if (line.startsWith("rename to ")) { f.newPath = line.slice(10); continue; }
      const im = line.match(/^index ([0-9a-f]{40,64})\.\.([0-9a-f]{40,64})/);
      if (im) { f.oldBlob = im[1]!; f.newBlob = im[2]!; continue; }
      if (line.startsWith("--- ")) { const p = line.slice(4); if (p !== "/dev/null") f.oldPath = p.replace(/^a\//, ""); continue; }
      if (line.startsWith("+++ ")) { const p = line.slice(4); if (p !== "/dev/null") f.newPath = p.replace(/^b\//, ""); continue; }
    }
    const hm = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hm) {
      oldNo = parseInt(hm[1]!, 10); newNo = parseInt(hm[2]!, 10);
      h = { header: line, rows: [] };
      f.hunks.push(h);
      continue;
    }
    if (!h) continue;
    if (line.startsWith("+")) h.rows.push({ type: "add", oldNo: null, newNo: newNo++, text: line.slice(1), anns: [] });
    else if (line.startsWith("-")) h.rows.push({ type: "del", oldNo: oldNo++, newNo: null, text: line.slice(1), anns: [] });
    else if (line.startsWith(" ") || line === "") h.rows.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1), anns: [] });
    // "\ No newline at end of file" ignored
  }
  return files;
}

// ---------- intraline (word-level) highlighting ----------

/**
 * Pair the i-th deleted with the i-th added line of each edit run (a maximal
 * stretch of non-context rows) and mark the word-level differences, skipping
 * pairs that are mostly different (a full-line mark is just noise).
 */
function computeIntraline(hunk: Hunk): void {
  let run: Row[] = [];
  const flush = () => {
    const dels = run.filter(r => r.type === "del");
    const adds = run.filter(r => r.type === "add");
    for (let i = 0; i < Math.min(dels.length, adds.length); i++) markPair(dels[i]!, adds[i]!);
    run = [];
  };
  for (const r of hunk.rows) {
    if (r.type === "ctx") flush();
    else run.push(r);
  }
  flush();
}

function markPair(d: Row, a: Row): void {
  if (!d.text.trim() || !a.text.trim()) return;
  const del: [number, number][] = [], add: [number, number][] = [];
  let dp = 0, ap = 0, changed = 0;
  for (const p of diffWordsWithSpace(d.text, a.text)) {
    const len = p.value.length;
    if (p.removed) { pushRange(del, dp, dp + len); changed += len; dp += len; }
    else if (p.added) { pushRange(add, ap, ap + len); changed += len; ap += len; }
    else { dp += len; ap += len; }
  }
  if (changed === 0 || changed / (d.text.length + a.text.length) > 0.65) return;
  d.marks = del;
  a.marks = add;
}

function pushRange(ranges: [number, number][], start: number, end: number): void {
  const last = ranges.at(-1);
  if (last && last[1] === start) last[1] = end;
  else ranges.push([start, end]);
}

/**
 * Wrap the given source-text ranges of an HTML string in <mark> tags, walking
 * tags and entities so positions refer to text characters. Marks close and
 * reopen around every tag, so span boundaries can't produce invalid nesting.
 */
function insertMarks(html: string, ranges: [number, number][], cls: string): string {
  if (!ranges.length) return html;
  const open = `<mark class="${cls}">`;
  let out = "", pos = 0, ri = 0, marking = false, i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const j = html.indexOf(">", i);
      if (j === -1) break;
      if (marking) out += "</mark>";
      out += html.slice(i, j + 1);
      if (marking) out += open;
      i = j + 1;
      continue;
    }
    while (ri < ranges.length && pos >= ranges[ri]![1]) ri++;
    if (!marking && ri < ranges.length && pos >= ranges[ri]![0] && pos < ranges[ri]![1]) { out += open; marking = true; }
    let chunk = html[i]!;
    if (chunk === "&") {
      const j = html.indexOf(";", i);
      if (j > i && j - i <= 9) chunk = html.slice(i, j + 1); // entity = one text char
    }
    out += chunk;
    i += chunk.length;
    pos++;
    if (marking && (ri >= ranges.length || pos >= ranges[ri]![1])) { out += "</mark>"; marking = false; }
  }
  out += html.slice(i);
  if (marking) out += "</mark>";
  return out;
}

// ---------- anchor resolution ----------

/**
 * Resolves anchors against both sides of the diff. Line identity comes from
 * positional mapping: `git diff -U0 anchorSha..side -- path` yields the
 * regions that changed; anchor lines outside them shift by the running delta,
 * lines inside them have no surviving image on that side. Mapping to the head
 * side finds where anchored code lives now; mapping to the merge-base side
 * lets anchors written against an older commit land on deleted rows.
 */
class Resolver {
  private revCache = new Map<string, Promise<string>>();
  private renameMaps = new Map<string, Promise<Map<string, string>>>();
  private lineMaps = new Map<string, Promise<(line: number) => number | null>>();

  constructor(
    private headSha: string,
    private mergeBase: string,
    private fileIdxByPath: Map<string, number>,
    private fileIdxByOldPath: Map<string, number>,
  ) {}

  async resolve(a: Anchor): Promise<ResolvedAnchor> {
    const notes: string[] = [];
    const anchorSha = await this.rev(a.sha);

    // Renames first: if the anchor's path was renamed away AND a new file took
    // its place, the rename target — not the impostor — is where it lives now.
    const headPath = await this.sidePath(anchorSha, a.path, this.headSha);
    const basePath = await this.sidePath(anchorSha, a.path, this.mergeBase);
    const fileIdx = (headPath !== null ? this.fileIdxByPath.get(headPath) : undefined)
      ?? (basePath !== null ? this.fileIdxByOldPath.get(basePath) : undefined)
      ?? null;

    if (a.wholeFile) return { ...a, fileIdx, headLines: [], baseLines: [], drifted: 0, rendered: 0, notes };

    const content = await fetchContent(anchorSha, a.path);
    if (content === null) return deadAnchor(a, `path not found at ${a.sha.slice(0, 9)}`);
    const lineCount = countLines(content);
    if (a.start > lineCount) notes.push(`range starts past end of file (${lineCount} lines at ${a.sha.slice(0, 9)})`);
    else if (a.end > lineCount) notes.push(`range extends past end of file (${lineCount} lines at ${a.sha.slice(0, 9)})`);
    const end = Math.min(a.end, lineCount);

    const headMap = headPath !== null ? await this.lineMap(anchorSha, a.path, this.headSha, headPath) : null;
    const baseMap = basePath !== null ? await this.lineMap(anchorSha, a.path, this.mergeBase, basePath) : null;

    const headLines: number[] = [], baseLines: number[] = [];
    let survived = 0;
    for (let line = a.start; line <= end; line++) {
      const hn = headMap?.(line) ?? null;
      const bn = baseMap?.(line) ?? null;
      if (hn !== null) headLines.push(hn);
      if (bn !== null) baseLines.push(bn);
      if (hn !== null || bn !== null) survived++;
    }
    // Out-of-range lines count as drifted too: the anchor names lines that
    // don't exist, and a zero here would hide that (and could otherwise go
    // negative, cancelling real drift elsewhere in the page totals).
    const drifted = (a.end - a.start + 1) - survived;
    return { ...a, fileIdx, headLines, baseLines, drifted, rendered: 0, notes };
  }

  private rev(sha: string): Promise<string> {
    return cached(this.revCache, sha, async () => (await git("rev-parse", `${sha}^{commit}`)).trim());
  }

  /** The anchor path's name at another commit: rename target, same path, or gone. */
  private async sidePath(fromSha: string, path: string, toSha: string): Promise<string | null> {
    if (fromSha === toSha) return path;
    const renamed = (await this.renameMap(fromSha, toSha)).get(path);
    if (renamed) return renamed;
    return (await existsAt(toSha, path)) ? path : null;
  }

  /** old path -> new path for renames between two commits. */
  private renameMap(fromSha: string, toSha: string): Promise<Map<string, string>> {
    return cached(this.renameMaps, `${fromSha}..${toSha}`, async () => {
      const map = new Map<string, string>();
      for (const line of (await git("diff", "--name-status", "-M", fromSha, toSha)).split("\n")) {
        const m = line.match(/^R\d+\t([^\t]+)\t([^\t]+)$/);
        if (m) map.set(m[1]!, m[2]!);
      }
      return map;
    });
  }

  /** Positional line mapping fromSha:fromPath -> toSha:toPath via -U0 hunks. */
  private lineMap(fromSha: string, fromPath: string, toSha: string, toPath: string): Promise<(line: number) => number | null> {
    return cached(this.lineMaps, `${fromSha}:${fromPath}..${toSha}:${toPath}`, async () => {
      if (fromSha === toSha && fromPath === toPath) return (line: number) => line;
      // Both sides in the pathspec plus -M, so a renamed file maps line-to-line
      // instead of parsing as a full delete + add.
      const paths = fromPath === toPath ? [fromPath] : [fromPath, toPath];
      const out = await git("diff", "-U0", "-M", fromSha, toSha, "--", ...paths);
      const hunks: { a: number; b: number; d: number }[] = [];
      for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(?:\d+)(?:,(\d+))? @@/gm)) {
        hunks.push({ a: parseInt(m[1]!, 10), b: m[2] !== undefined ? parseInt(m[2], 10) : 1, d: m[3] !== undefined ? parseInt(m[3], 10) : 1 });
      }
      return (line: number) => {
        let delta = 0;
        for (const h of hunks) {
          if (h.b > 0 && line >= h.a && line < h.a + h.b) return null; // inside a changed region
          if (h.b > 0 ? line >= h.a + h.b : line > h.a) delta += h.d - h.b;
          else break;
        }
        return line + delta;
      };
    });
  }
}

// ---------- symbol definitions (go-to-definition) ----------

interface Def { name: string; fileIdx: number; path: string; line: number; }

const JS_LANGS = new Set(["typescript", "tsx", "javascript", "jsx", "astro"]);
// Module-level definitions only (no indentation) — locals would drown the
// index in false targets like `const title = …` inside functions.
const DEF_RE = /^(?:export\s+)?(?:(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)|interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*=)/;
const MAX_SCAN_BYTES = 2_000_000;

/** Scan head versions of the diff's JS-family files for definitions. */
function collectDefs(files: DiffFile[], headSha: string): Def[] {
  const defs: Def[] = [];
  files.forEach((f, fileIdx) => {
    if (!f.newPath || !JS_LANGS.has(langFor(f.newPath) ?? "")) return;
    const lines = linesOf(headSha, f.newPath);
    if (!lines || lines.reduce((n, l) => n + l.length, 0) > MAX_SCAN_BYTES) return;
    lines.forEach((lineText, i) => {
      const m = lineText.match(DEF_RE);
      if (m) defs.push({ name: (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5])!, fileIdx, path: f.newPath!, line: i + 1 });
    });
  });
  return defs;
}

// ---------- materialization + coverage ----------

// Display numbers: anchor-less annotations are general comments (preamble,
// overview) and get no number; anchored annotations number sequentially so
// claim ids start at "1a".
function displayNumbers(annotations: Annotation[]): (number | null)[] {
  let n = 0;
  return annotations.map(a => (a.anchors.length ? ++n : null));
}

// Claim id shown on gutter badges: annotation number + bullet letter, e.g. "3b".
function claimId(no: number, bullet: number | null): string {
  return `${no}${bullet !== null ? letterOf(bullet) : ""}`;
}

/**
 * Tag every diff row with the annotations covering it. Line anchors tag their
 * mapped head lines (and, via the merge-base mapping, deleted rows); deleted
 * rows sharing an edit run with tagged added rows inherit those annotations
 * (they're the code the tagged lines replaced). Whole-file anchors tag all of
 * the file's changed rows. Line anchors go first so a shared row keeps the
 * more specific annotation as its primary (click target). Returns, per file,
 * the annotations that cover it whole (one gutter badge per file, not per run).
 */
function materializeOntoRows(annotations: Annotation[], files: DiffFile[], displayNo: (number | null)[]): Map<number, Set<number>> {
  const wholeFileAnns = new Map<number, Set<number>>();
  const tag = (row: Row, ai: number, r: ResolvedAnchor) => {
    if (!row.anns.some(x => x.ai === ai)) row.anns.push({ ai, claim: claimId(displayNo[ai]!, r.bullet) });
    r.rendered++;
  };
  const eachAnchor = (wholeFile: boolean, fn: (r: ResolvedAnchor, ai: number, fileIdx: number) => void) =>
    annotations.forEach((ann, ai) => ann.resolved.forEach(r => {
      if (r.wholeFile === wholeFile && r.fileIdx !== null) fn(r, ai, r.fileIdx);
    }));

  eachAnchor(false, (r, ai, fileIdx) => {
    const heads = new Set(r.headLines);
    const bases = new Set(r.baseLines);
    for (const hunk of files[fileIdx]!.hunks) for (const row of hunk.rows) {
      if ((row.newNo !== null && heads.has(row.newNo)) || (row.type === "del" && row.oldNo !== null && bases.has(row.oldNo))) {
        tag(row, ai, r);
      }
    }
  });

  // Adjacency: within an edit run, deleted rows are what the added rows
  // replaced — an annotation anchored (at head) on the replacement covers them.
  for (const f of files) for (const hunk of f.hunks) {
    let run: Row[] = [];
    const flush = () => {
      const fromAdds = new Map<number, RowAnn>();
      for (const row of run) if (row.type === "add") for (const x of row.anns) if (!fromAdds.has(x.ai)) fromAdds.set(x.ai, x);
      if (fromAdds.size) for (const row of run) {
        if (row.type === "del") for (const x of fromAdds.values()) {
          if (!row.anns.some(y => y.ai === x.ai)) row.anns.push({ ...x });
        }
      }
      run = [];
    };
    for (const row of hunk.rows) {
      if (row.type === "ctx") flush();
      else run.push(row);
    }
    flush();
  }

  eachAnchor(true, (r, ai, fileIdx) => {
    let set = wholeFileAnns.get(fileIdx);
    if (!set) { set = new Set(); wholeFileAnns.set(fileIdx, set); }
    set.add(ai);
    for (const hunk of files[fileIdx]!.hunks) for (const row of hunk.rows) {
      if (row.type !== "ctx") tag(row, ai, r);
    }
    if (files[fileIdx]!.hunks.length === 0) r.rendered++; // binary/rename-only: the file box itself
  });
  return wholeFileAnns;
}

/**
 * Every changed (non-context) row should carry an annotation. Files with no
 * hunks (binary, rename-only, mode-only) count as one unit each, covered by a
 * whole-file anchor — a swapped image is a change needing explanation too.
 */
function computeCoverage(files: DiffFile[], wholeFileAnns: Map<number, Set<number>>): { covered: number; total: number } {
  let covered = 0, total = 0;
  files.forEach((f, fi) => {
    if (f.hunks.length === 0) {
      total++;
      if (wholeFileAnns.has(fi)) covered++;
      return;
    }
    for (const h of f.hunks) for (const r of h.rows) {
      if (r.type === "ctx") continue;
      total++;
      if (r.anns.length) covered++;
    }
  });
  return { covered, total };
}

// ---------- rendering ----------

const esc = (s: string): string => Bun.escapeHTML(s);

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", jsx: "jsx",
  astro: "astro", scss: "scss", css: "css", yml: "yaml", yaml: "yaml",
  md: "markdown", mdx: "mdx", json: "json", html: "html", py: "python", sh: "shellscript",
};
// Machine-generated files: highlighting them costs megabytes of markup for
// nothing a reviewer reads token-by-token.
const SKIP_HIGHLIGHT = /(^|\/)(package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml)$|\.min\.(js|css)$|\.map$/;

function langFor(path: string | null): string | null {
  if (!path) return null;
  return LANG_BY_EXT[path.split(".").pop() ?? ""] ?? null;
}

function annColor(i: number): string {
  const hues = [210, 25, 130, 280, 340, 60, 180, 305, 95, 240, 15];
  return `hsl(${hues[i % hues.length]} 65% 45%)`;
}

interface PageContext {
  label: string;               // "owner/repo#N" or "base…head", for the title bar
  labelUrl?: string;           // the PR's GitHub URL; the title bar label links to it
  base: string; head: string; headSha: string; mergeBase: string;
  storeKey: string;
  files: DiffFile[];
  annotations: Annotation[];
  narrative: number[];         // file indices in first-anchor-mention order
  unannotated: number[];       // file indices no annotation references
  wholeFileAnns: Map<number, Set<number>>;
  displayNo: (number | null)[];
  coverage: { covered: number; total: number };
  fileHashes: string[];
  highlighter: Highlighter;
  defs: Def[];
  viewerCss: string;
  viewerJs: string;
}

function renderPage(ctx: PageContext): string {
  const { files, annotations, coverage, headSha, mergeBase } = ctx;

  // Which files define each symbol name: a token only becomes a link when the
  // target is unambiguous (defined in this file, or in exactly one file).
  const defFiles = new Map<string, Set<number>>();
  for (const d of ctx.defs) cached(defFiles as Map<string, Set<number>>, d.name, () => new Set<number>()).add(d.fileIdx);
  const linkedNames = new Set<string>();
  // github-light's string/comment colors — tokens painted these aren't
  // identifier references, however exactly their text matches a symbol name.
  const NON_REF_COLORS = new Set(["#0a3069", "#6e7781"]);

  // Highlight a full file version once; diff rows pick lines by number. Whole-file
  // highlighting (vs per-line) keeps multi-line tokens like block comments correct.
  // Head-side tokens matching a known symbol become go-to-definition links.
  const hlCache = new Map<string, string[] | null>();
  function highlightedLinesFor(sha: string, path: string | null): string[] | null {
    if (!path) return null;
    return cached(hlCache, `${sha}:${path}`, () => {
      const lang = langFor(path);
      if (!lang || SKIP_HIGHLIGHT.test(path)) return null;
      const content = linesOf(sha, path)?.join("\n") ?? null;
      if (content === null || content.length >= MAX_SCAN_BYTES) return null;
      const fileIdx = sha === headSha ? files.findIndex(f => f.newPath === path) : -1;
      const linkDefs = sha === headSha && JS_LANGS.has(lang);
      try {
        const { tokens } = ctx.highlighter.codeToTokens(content, { lang: lang as never, theme: "github-light" });
        return tokens.map(line => line.map(t => {
          const text = esc(t.content);
          const name = t.content.trim();
          const targets = linkDefs && !NON_REF_COLORS.has((t.color ?? "").toLowerCase()) ? defFiles.get(name) : undefined;
          const linkable = targets !== undefined && (targets.has(fileIdx) || targets.size === 1);
          const inner = linkable
            ? `<a class="def" data-sym="${esc(name)}" title="Go to definition">${text}</a>`
            : text;
          return `<span style="color:${t.color ?? "inherit"}">${inner}</span>`;
        }).join(""));
      } catch {
        return null; // plain fallback
      }
    });
  }

  function renderCard(ann: Annotation, ai: number): string {
    // Anchor links were stamped with their index at parse time; the renderer
    // pairs each with its resolution by that identity, not by scan order.
    const renderer = new Renderer();
    const origLink = renderer.link.bind(renderer);
    const origLi = renderer.listitem.bind(renderer);
    renderer.link = (token: Tokens.Link): string => {
      const idx = (token as AnchorToken)._anchorIdx;
      if (idx === undefined) return origLink(token);
      const r = ann.resolved[idx]!;
      const text = renderer.parser.parseInline(token.tokens);
      const dead = r.fileIdx === null || (!r.wholeFile && r.headLines.length === 0 && r.baseLines.length === 0);
      const offscreen = !dead && !r.wholeFile && r.rendered === 0;
      const total = r.end - r.start + 1;
      const drift = r.drifted > 0 ? `<sup class="drift" title="${r.drifted} of ${total} anchor lines were modified or deleted after this annotation was written">⚠</sup>` : "";
      const hint = dead ? " — not in this diff" : offscreen ? " — outside the diff's hunks; jumps to the file" : "";
      const cls = dead ? " dead" : offscreen ? " nsd" : "";
      return `<a class="iref${cls}" data-ann="${ai}" data-anchor="${idx}" title="${esc(anchorSpan(r))}${hint}">${text}</a>${drift}`;
    };
    renderer.listitem = (item: Tokens.ListItem): string => {
      const html = origLi(item);
      const claim = (item as ClaimItem)._claim;
      return claim ? html.replace("<li", `<li data-claim="${claim}"`) : html;
    };
    const body = marked.parser(ann.bodyTokens as never, { renderer }) as string;

    const no = ctx.displayNo[ai];
    // Anchor-less annotations are general comments: no number, no color, no
    // lettered claims — a preamble card rather than a claim-set.
    const badge = no === null ? "" : `<span class="badge">${no}</span>`;
    return `<article class="card${no === null ? " general" : ""}" id="ann-${ai}"${no === null ? "" : ` style="--ac:${annColor(ai)}"`}>
      <header>${badge}<h3>${ann.titleHtml}</h3><button class="check acheck" data-ann="${ai}" title="Mark annotation${no === null ? "" : " (and all its files)"} as reviewed"></button></header>
      <div class="body">${body}</div>
    </article>`;
  }

  function renderRow(r: Row, fi: number, badges: RowAnn[], newHl: string[] | null, oldHl: string[] | null): string {
    const hlLine = r.type === "del"
      ? (oldHl && r.oldNo !== null ? oldHl[r.oldNo - 1] : undefined)
      : (newHl && r.newNo !== null ? newHl[r.newNo - 1] : undefined);
    // Only names linked on lines that actually reach the page belong in the
    // symbols index — whole-file highlighting links plenty that never renders.
    if (hlLine?.includes("data-sym")) {
      for (const m of hlLine.matchAll(/data-sym="([^"]+)"/g)) linkedNames.add(m[1]!);
    }
    let code = hlLine ?? esc(r.text);
    if (r.marks?.length) code = insertMarks(code, r.marks, r.type === "del" ? "ind" : "ina");

    const classes = [r.type, r.type !== "ctx" && !r.anns.length ? "unc" : ""].filter(Boolean).join(" ");
    // Overlapping annotations each get a stripe band, newest-specific first.
    const stripes = r.anns.slice(0, 4).map((x, i) => `inset ${3 * (i + 1)}px 0 0 ${annColor(x.ai)}`).join(",");
    const attrs = [
      `class="${classes}"`,
      r.newNo !== null ? `id="L-${fi}-${r.newNo}"` : r.oldNo !== null ? `id="D-${fi}-${r.oldNo}"` : "",
      r.anns.length ? `data-anns="${r.anns.map(x => x.ai).join(" ")}" style="--mkshadow:${stripes}"` : "",
    ].filter(Boolean).join(" ");
    const gutter = badges
      .map(x => `<button class="mark" data-ann="${x.ai}" style="--mk:${annColor(x.ai)}" title="${esc(ctx.annotations[x.ai]!.title)}">${x.claim}</button>`)
      .join("");

    return `<tr ${attrs}><td class="g">${gutter}</td><td class="n">${r.oldNo ?? ""}</td><td class="n">${r.newNo ?? ""}</td><td class="c"><pre>${code || " "}</pre></td></tr>`;
  }

  function renderFile(fi: number): string {
    const f = files[fi]!;
    const path = f.newPath ?? f.oldPath ?? "?";
    const covered = ctx.wholeFileAnns.has(fi);

    let body = "";
    if (f.binary) body = `<div class="note${covered ? "" : " unc"}">Binary file</div>`;
    else if (f.hunks.length === 0) body = `<div class="note${covered ? "" : " unc"}">${f.status === "renamed" ? `Renamed from ${esc(f.oldPath ?? "")}` : "No content changes"}</div>`;
    else {
      const newHl = f.status !== "deleted" ? highlightedLinesFor(headSha, f.newPath) : null;
      const hasDel = f.hunks.some(h => h.rows.some(r => r.type === "del"));
      const oldHl = hasDel && f.status !== "added" ? highlightedLinesFor(mergeBase, f.oldPath) : null;
      const wfAnns = ctx.wholeFileAnns.get(fi) ?? new Set<number>();
      const wfBadged = new Set<number>();
      body = f.hunks.map(h => {
        computeIntraline(h);
        // One badge per annotation per run of rows carrying it — except
        // whole-file annotations, which get a single badge per file.
        let prev = new Set<number>();
        const rows = h.rows.map(r => {
          const badges = r.anns.filter(x => {
            if (prev.has(x.ai)) return false;
            if (wfAnns.has(x.ai)) {
              if (wfBadged.has(x.ai)) return false;
              wfBadged.add(x.ai);
            }
            return true;
          });
          prev = new Set(r.anns.map(x => x.ai));
          return renderRow(r, fi, badges, newHl, oldHl);
        }).join("");
        return `<div class="hunk"><div class="hh">${esc(h.header)}</div><table>${rows}</table></div>`;
      }).join("");
      // The merge-base side is only read while rendering this file; the head
      // side may still feed definition snippets below.
      if (f.oldPath) hlCache.delete(`${mergeBase}:${f.oldPath}`);
    }

    return `<div class="file" id="file-${fi}">
      <div class="fhead"><code>${esc(path)}</code>${f.status === "renamed" ? ` <span class="rn">← ${esc(f.oldPath ?? "")}</span>` : ""}<span class="stat">${f.status}</span><button class="check fcheck" data-file="${fi}" title="Mark file as reviewed (minimizes it)"></button></div>
      <div class="fbody">${body}</div>
    </div>`;
  }

  const annotatedFiles = ctx.narrative.map(renderFile).join("\n");
  const restFiles = ctx.unannotated.length
    ? `<h2 class="divider">Unannotated changes <span>(${ctx.unannotated.length} files — nothing below has an annotation)</span></h2>\n` + ctx.unannotated.map(renderFile).join("\n")
    : "";
  // Cards render after the diff so anchors know their rendered row counts and
  // the highlight cache is warm for definition snippets.
  const cards = annotations.map(renderCard).join("\n");

  const allCovered = coverage.covered === coverage.total;
  const driftTotal = annotations.reduce((n, a) => n + a.resolved.reduce((m, r) => m + r.drifted, 0), 0);

  // Symbol index for go-to-definition — only names some rendered token
  // actually links to. Snippets (definition line + 4) let the viewer show
  // definitions whose lines aren't rendered in any diff hunk.
  const symbols: Record<string, { file: number; line: number; snippet: string }[]> = Object.create(null);
  for (const d of ctx.defs) {
    if (!linkedNames.has(d.name)) continue;
    const hlLines = highlightedLinesFor(headSha, d.path);
    const plain = linesOf(headSha, d.path) ?? [];
    const snippet = plain.slice(d.line - 1, d.line + 4)
      .map((l, i) => hlLines?.[d.line - 1 + i] ?? esc(l))
      .join("\n");
    (symbols[d.name] ??= []).push({ file: d.fileIdx, line: d.line, snippet });
  }

  const data = {
    ranges: annotations.map(a => a.resolved.map(r => ({
      file: r.fileIdx,
      lines: r.headLines,
      b: r.baseLines.length ? r.baseLines : undefined,
      all: r.wholeFile || undefined,
    }))),
    titles: annotations.map(a => a.title),
    annKeys: annotations.map(a => a.key),
    filePaths: files.map(f => f.newPath ?? f.oldPath ?? "?"),
    fileHashes: ctx.fileHashes,
    storeKey: ctx.storeKey,
    symbols,
  };
  // "</script>" inside a title or path must not terminate the inline script;
  // U+2028/U+2029 are line terminators in JS source but not in JSON.
  const dataJson = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Guide: ${esc(ctx.label)}</title>
<style>
${ctx.viewerCss}
</style></head>
<body>
<div class="topbar">
  <span>Annotated guide</span>
  <span>${ctx.labelUrl ? `<a href="${esc(ctx.labelUrl)}" target="_blank" rel="noreferrer">${esc(ctx.label)}</a>` : esc(ctx.label)} — <code>${esc(ctx.base.slice(0, 24))}</code> … <code>${esc(ctx.head)}</code> (${esc(headSha.slice(0, 9))})</span>
  <span>${files.length} files, ${annotations.length} annotations</span>
  <span class="${allCovered ? "" : "warn"}">coverage: ${coverage.covered}/${coverage.total} changes</span>
  <button id="showunc"${allCovered ? " disabled" : ""}>${allCovered ? "✓ all changes covered" : `Show uncovered (${coverage.total - coverage.covered})`}</button>
  <button id="togglenums">Line numbers</button>
  <span id="revcount"></span>
  ${driftTotal ? `<span class="warn">⚠ ${driftTotal} anchor lines drifted since annotation</span>` : ""}
</div>
<div class="layout">
  <aside id="panel">${cards}</aside>
  <main id="diff"><div id="focusbar"><span id="focuslabel"></span><button id="unfocus">Show all changes (Esc)</button></div>${annotatedFiles}\n${restFiles}</main>
</div>
<script>
const DATA = ${dataJson};
${ctx.viewerJs}
</script>
</body></html>`;
}

// ---------- PR fetching (GitHub) ----------

interface PrInfo {
  number: number; title: string; url: string; state: string;
  baseRefName: string; baseRefOid: string; headRefOid: string;
  owner: string; repo: string; cacheDir: string; localHeadRef: string;
}

/**
 * Resolve a PR spec, clone/fetch its repo into repos/<owner>__<repo> (the
 * "__" separator keeps foo-bar/baz and foo/bar-baz apart), and work out the
 * base commit the PR should be diffed against. For merged PRs the base
 * branch's tip already contains the head, so the true base is the merge
 * commit's first parent — the branch as it stood when the PR landed.
 */
async function fetchPr(spec: string): Promise<PrInfo> {
  const m = spec.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    ?? spec.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (!m) throw new Error(`cannot parse PR spec '${spec}' — expected a github.com PR URL or owner/repo#N`);
  const [, owner, repo, num] = m as unknown as [string, string, string, string];
  const url = `https://github.com/${owner}/${repo}/pull/${num}`;

  const gh = await $`gh pr view ${url} --json number,title,url,state,baseRefName,headRefOid,mergeCommit`.env(GIT_ENV).quiet().nothrow();
  if (gh.exitCode !== 0) throw new Error(`gh pr view ${url} failed: ${gh.stderr.toString().trim()}`);
  const info = JSON.parse(gh.stdout.toString()) as {
    number: number; title: string; url: string; state: string;
    baseRefName: string; headRefOid: string;
    mergeCommit: { oid: string } | null;
  };

  const cacheDir = join(TOOL_DIR, "repos", `${owner}__${repo}`);
  if (!(await Bun.file(join(cacheDir, ".git", "HEAD")).exists())) {
    const clone = await $`git clone --quiet ${`https://github.com/${owner}/${repo}.git`} ${cacheDir}`.env(GIT_ENV).quiet().nothrow();
    if (clone.exitCode !== 0) throw new Error(`git clone of ${owner}/${repo} failed: ${clone.stderr.toString().trim()}`);
  }

  const localHeadRef = `pr-${num}`;
  await gitIn(cacheDir, ["fetch", "--quiet", "--force", "origin", `pull/${num}/head:${localHeadRef}`]);
  const fetchedHead = (await gitIn(cacheDir, ["rev-parse", localHeadRef])).trim();
  if (fetchedHead !== info.headRefOid) {
    console.warn(`warn: fetched PR head ${fetchedHead.slice(0, 9)} differs from the API's ${info.headRefOid.slice(0, 9)} (force-push in flight?); using the fetched ref`);
  }

  let baseOid: string;
  if (info.state === "MERGED" && info.mergeCommit?.oid) {
    await $`git -C ${cacheDir} fetch --quiet origin ${info.mergeCommit.oid}`.env(GIT_ENV).quiet().nothrow();
    baseOid = (await gitIn(cacheDir, ["rev-parse", `${info.mergeCommit.oid}^1`])).trim();
  } else {
    const branchFetch = await $`git -C ${cacheDir} fetch --quiet origin ${info.baseRefName}`.env(GIT_ENV).quiet().nothrow();
    if (branchFetch.exitCode === 0) {
      baseOid = (await gitIn(cacheDir, ["rev-parse", "FETCH_HEAD"])).trim();
    } else {
      // Base branch deleted on the remote (e.g. a stacked PR's parent): fall
      // back to the API's recorded base commit, fetched by sha.
      const api = await $`gh api ${`repos/${owner}/${repo}/pulls/${num}`} --jq .base.sha`.env(GIT_ENV).quiet().nothrow();
      const apiBase = api.stdout.toString().trim();
      const shaFetch = apiBase
        ? await $`git -C ${cacheDir} fetch --quiet origin ${apiBase}`.env(GIT_ENV).quiet().nothrow()
        : null;
      if (!shaFetch || shaFetch.exitCode !== 0) {
        throw new Error(`base branch '${info.baseRefName}' no longer exists on the remote and its recorded base commit could not be fetched: ${(shaFetch ?? api).stderr.toString().trim()}`);
      }
      baseOid = apiBase;
    }
  }

  const mergeBase = (await gitIn(cacheDir, ["merge-base", baseOid, fetchedHead])).trim();
  if (mergeBase === fetchedHead) {
    throw new Error(`the base already contains the PR head — nothing to diff. (Merged PR with no merge commit recorded? Pass explicit base/head instead.)`);
  }

  return {
    number: info.number, title: info.title, url: info.url, state: info.state,
    baseRefName: info.baseRefName, baseRefOid: baseOid, headRefOid: fetchedHead,
    owner, repo, cacheDir, localHeadRef,
  };
}

/** origin/HEAD's branch, else main/master — for when no base is given. */
async function defaultBase(): Promise<string> {
  try {
    return (await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD")).trim();
  } catch { /* no origin/HEAD ref */ }
  for (const cand of ["main", "master"]) {
    try { await git("rev-parse", "--verify", `${cand}^{commit}`); return cand; } catch { /* try next */ }
  }
  throw new Error("no base given and neither 'main' nor 'master' exists — pass a base explicitly");
}

// ---------- main ----------

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      annotations: { type: "string", default: "review/annotations.md" },
      out: { type: "string", default: "review/review.html" },
    },
  });

  if (positionals[0] === "fetch") {
    if (!positionals[1]) throw new Error("usage: generate.ts fetch <pr-url | owner/repo#N>");
    console.log(JSON.stringify(await fetchPr(positionals[1])));
    return;
  }

  let base: string, head: string, label: string, storeKey: string;
  let labelUrl: string | undefined;
  if (values.pr) {
    const info = await fetchPr(values.pr);
    REPO = info.cacheDir;
    base = info.baseRefOid;
    head = info.localHeadRef;
    label = `${info.owner}/${info.repo}#${info.number}`;
    labelUrl = info.url;
    // Keyed on the PR, not on commit oids: reviewed-state then survives both
    // regeneration and the base branch advancing under the PR.
    storeKey = `annotated-review:${info.owner}/${info.repo}#${info.number}`;
  } else {
    REPO = resolvePath(values.repo ?? ".");
    base = positionals[0] ?? await defaultBase();
    head = positionals[1] ?? "HEAD";
    label = `${base.slice(0, 12)}…${head}`;
    storeKey = `annotated-review:${base}...${head}`;
  }
  // Root-relative paths everywhere: git's diff/show output is root-relative,
  // so running from a subdirectory must not change what the paths mean.
  REPO = (await git("rev-parse", "--show-toplevel")).trim();

  const headSha = (await git("rev-parse", `${head}^{commit}`)).trim();
  const mergeBase = (await git("merge-base", base, headSha)).trim();

  // Explicit prefixes and --full-index defeat user diff config (noprefix,
  // abbreviated index lines) that would break path stripping and blob hashes.
  const files = parseDiff(await git("diff", "--no-color", "-M", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", mergeBase, headSha));
  const fileIdxByPath = new Map<string, number>();
  const fileIdxByOldPath = new Map<string, number>();
  files.forEach((f, i) => {
    if (f.newPath) fileIdxByPath.set(f.newPath, i);
    if (f.oldPath) fileIdxByOldPath.set(f.oldPath, i);
  });

  // Blob hashes: content identity for the viewer's reviewed state (head side;
  // merge-base side for deleted files) — straight from the diff's index lines.
  // Pure renames and mode-only changes carry no index line; ask git for those.
  const zeros = /^0+$/;
  const fileHashes = await pool(files, 8, async f => {
    const blob = f.status === "deleted" ? f.oldBlob : f.newBlob;
    if (blob && !zeros.test(blob)) return blob;
    if (f.oldBlob && !zeros.test(f.oldBlob)) return f.oldBlob;
    try {
      return f.newPath
        ? (await git("rev-parse", `${headSha}:${f.newPath}`)).trim()
        : (await git("rev-parse", `${mergeBase}:${f.oldPath}`)).trim();
    } catch {
      return "?";
    }
  });

  // A branch without an annotations file still gets a diff page — everything
  // simply lands under "Unannotated changes" with coverage 0.
  const annotationsFile = Bun.file(values.annotations);
  const hasAnnotations = await annotationsFile.exists();
  if (!hasAnnotations) console.warn(`warn: ${values.annotations} not found; generating without annotations`);
  const annotations = hasAnnotations ? parseAnnotations(await annotationsFile.text()) : [];

  const resolver = new Resolver(headSha, mergeBase, fileIdxByPath, fileIdxByOldPath);
  const anchorJobs = annotations.flatMap(ann => ann.anchors.map(a => ({ ann, a })));
  const resolvedList = await pool(anchorJobs, 8, async ({ ann, a }) => {
    try {
      return await resolver.resolve(a);
    } catch (e) {
      console.warn(`warn: anchor ${anchorSpan(a)} failed to resolve: ${(e as Error).message.split("\n")[0]}`);
      return deadAnchor(a, "resolution failed");
    }
  });
  anchorJobs.forEach(({ ann }, i) => ann.resolved.push(resolvedList[i]!));

  const displayNo = displayNumbers(annotations);
  const wholeFileAnns = materializeOntoRows(annotations, files, displayNo);
  const coverage = computeCoverage(files, wholeFileAnns);

  // Narrative order: files in order of first anchor mention, then the rest.
  const narrative: number[] = [];
  const seen = new Set<number>();
  for (const ann of annotations) for (const r of ann.resolved) {
    if (r.fileIdx !== null && !seen.has(r.fileIdx)) { seen.add(r.fileIdx); narrative.push(r.fileIdx); }
  }
  const unannotated = files.map((_, i) => i).filter(i => !seen.has(i));

  // Prefetch every file version the renderer reads, in parallel, so rendering
  // itself can stay synchronous.
  await pool(files, 8, async f => {
    if (f.newPath) await fetchContent(headSha, f.newPath);
    if (f.oldPath && f.hunks.some(h => h.rows.some(r => r.type === "del"))) await fetchContent(mergeBase, f.oldPath);
  });

  const langs = [...new Set(files.map(f => langFor(f.newPath ?? f.oldPath)).filter((l): l is string => l !== null))];
  const highlighter = await createHighlighter({ themes: ["github-light"], langs });

  const html = renderPage({
    label, labelUrl, base, head, headSha, mergeBase, storeKey, files, annotations,
    narrative, unannotated, wholeFileAnns, displayNo, coverage, fileHashes, highlighter,
    defs: collectDefs(files, headSha),
    viewerCss: await Bun.file(join(TOOL_DIR, "viewer.css")).text(),
    viewerJs: await Bun.file(join(TOOL_DIR, "viewer.js")).text(),
  });
  await Bun.write(values.out, html); // creates the output directory if needed

  // Anchor health report: every silent failure mode gets a line.
  const report: string[] = [];
  for (const ann of annotations) for (const r of ann.resolved) {
    const where = `${anchorSpan(r)} (${ann.title})`;
    for (const note of r.notes) report.push(`  ${where}: ${note}`);
    if (r.fileIdx === null && !r.notes.length) report.push(`  ${where}: resolves to a file not in this diff — the link is dead`);
    else if (r.fileIdx !== null && !r.wholeFile && r.rendered === 0 && (r.headLines.length || r.baseLines.length)) {
      report.push(`  ${where}: lines fall outside the diff's rendered hunks — the link jumps to the file, not the lines`);
    }
    if (r.drifted > 0) report.push(`  ${where}: ${r.drifted} of ${r.end - r.start + 1} lines drifted since annotation`);
  }
  console.log(`Wrote ${values.out} — ${files.length} files, ${annotations.length} annotations, ${narrative.length} annotated files, ${unannotated.length} unannotated, coverage ${coverage.covered}/${coverage.total}.`);
  if (report.length) console.log(`Anchor warnings:\n${report.join("\n")}`);
}

main().catch(e => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
