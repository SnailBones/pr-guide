/**
 * Boots the generated page in happy-dom and drives the viewer: the page must
 * stay fully interactive even when localStorage is corrupted or throwing
 * (Safari denies it entirely on file:// documents).
 */
import { test, expect, beforeAll, afterEach } from "bun:test";
import { Window, type Document, type HTMLElement } from "happy-dom";
import { join } from "node:path";
import { buildFixture } from "./fixture";

const GENERATE = join(import.meta.dir, "..", "generate.ts");
let html = "";
let storeKey = "";

beforeAll(async () => {
  const fx = await buildFixture();
  const out = join(fx.repo, "review.html");
  const proc = Bun.spawnSync(["bun", GENERATE, "main", "HEAD", "--annotations", fx.annotationsFile, "--out", out],
    { cwd: fx.repo, stdout: "pipe", stderr: "pipe" });
  expect(proc.exitCode).toBe(0);
  html = await Bun.file(out).text();
  storeKey = html.match(/"storeKey":"([^"]+)"/)![1]!;
});

let open: Window[] = [];
afterEach(() => { open.forEach(w => w.close()); open = []; });

async function boot(prime?: (w: Window) => void) {
  const win = new Window({
    url: "file:///review.html",
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } as never,
  });
  open.push(win);
  const errors: string[] = [];
  win.addEventListener("error", e => errors.push(String((e as unknown as { message?: string }).message ?? e)));
  prime?.(win);
  win.document.write(html);
  await win.happyDOM.waitUntilComplete();
  return { win, errors, doc: win.document };
}

// happy-dom types querySelector as Element; everything we click is an HTMLElement.
const q = (doc: Document, sel: string) => doc.querySelector(sel) as HTMLElement;
const qa = (doc: Document, sel: string) => [...doc.querySelectorAll(sel)] as HTMLElement[];

test("boots and wires everything up", async () => {
  const { errors, doc } = await boot();
  expect(errors).toEqual([]);
  expect(doc.getElementById("revcount")?.textContent).toMatch(/reviewed: \d+\/\d+ files/);
});

test("each overlapping badge reaches its own card", async () => {
  const { doc } = await boot();
  const badges = qa(doc, ".mark[data-ann]");
  const anns = new Set(badges.map(b => b.getAttribute("data-ann")));
  expect(anns.size).toBeGreaterThan(1);
  for (const ai of anns) {
    const badge = badges.find(b => b.getAttribute("data-ann") === ai)!;
    badge.click();
    expect(doc.getElementById("ann-" + ai)?.classList.contains("active")).toBe(true);
  }
});

test("row click activates its first annotation's card", async () => {
  const { doc } = await boot();
  const row = q(doc, "tr[data-anns]");
  row.click();
  const first = row.getAttribute("data-anns")!.split(" ")[0];
  expect(doc.getElementById("ann-" + first)?.classList.contains("active")).toBe(true);
});

test("zero-row cards don't tear down an active focus", async () => {
  const { doc, win } = await boot();
  q(doc, ".card:not(.general)").click();
  expect(doc.body.classList.contains("focused")).toBe(true);
  q(doc, ".card.general").click();
  expect(doc.body.classList.contains("focused")).toBe(true); // unchanged
  doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
  expect(doc.body.classList.contains("focused")).toBe(false);
});

test("show uncovered toggles row-level focus", async () => {
  const { doc } = await boot();
  const btn = doc.getElementById("showunc") as HTMLElement;
  expect(btn.hasAttribute("disabled")).toBe(false);
  btn.click();
  expect(doc.body.classList.contains("rows-only")).toBe(true);
  btn.click();
  expect(doc.body.classList.contains("rows-only")).toBe(false);
});

test("reviewed state persists via localStorage", async () => {
  const { doc, win } = await boot();
  q(doc, ".fcheck").click();
  expect(q(doc, ".file").classList.contains("reviewed")).toBe(true);
  const saved = JSON.parse(win.localStorage.getItem(storeKey)!);
  expect(saved.files.length).toBe(1);
  expect(saved.files[0][1]).toMatch(/^[0-9a-f]{40,64}$/); // [path, blobHash]
});

test("a corrupted store cannot break the page", async () => {
  const { errors, doc } = await boot(w => w.localStorage.setItem(storeKey, '{"files":null,"anns":"bogus"}'));
  expect(errors).toEqual([]);
  const badge = q(doc, ".mark[data-ann]");
  badge.click(); // the click dispatcher must be alive
  expect(doc.getElementById("ann-" + badge.getAttribute("data-ann"))?.classList.contains("active")).toBe(true);
});

test("a throwing localStorage (Safari on file://) cannot break the page", async () => {
  const { errors, doc } = await boot(w => {
    Object.defineProperty(w, "localStorage", { get() { throw new Error("SecurityError"); } });
  });
  expect(errors).toEqual([]);
  const badge = q(doc, ".mark[data-ann]");
  badge.click();
  expect(doc.getElementById("ann-" + badge.getAttribute("data-ann"))?.classList.contains("active")).toBe(true);
});
