// Client-side behavior for the annotated review page. Inlined into review.html
// by generate.ts, which prepends a `DATA` constant with the page's data:
//   ranges     per annotation, per anchor: { file, lines, b?, all? } jump
//              targets (head-side line numbers; `b` = merge-base-side numbers
//              of deleted rows; `all` = whole-file anchor)
//   titles     annotation titles, by annotation index
//   annKeys    content hash per annotation (identity for reviewed state)
//   filePaths  diff file paths, by file section index
//   fileHashes blob hash per file section (content identity for reviewed state)
//   storeKey   localStorage key for this review
//   symbols    go-to-definition index: name -> [{ file, line, snippet }]
const { ranges: RANGES, titles: TITLES, annKeys: ANN_KEYS, filePaths: FILE_PATHS,
  fileHashes: FILE_HASHES, storeKey: STORE_KEY, symbols: SYMBOLS } = DATA;

const diffEl = document.getElementById("diff");
const panelEl = document.getElementById("panel");

// localStorage can throw (Safari on file:// URLs, private windows, quota) —
// the page must stay fully functional without it.
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* stays in-memory */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ----- DOM id scheme -----
// Encoded by generate.ts (renderRow / renderFile / renderCard); these helpers
// are the only decoders — keep the two files in sync.
const fileElOf = f => document.getElementById("file-" + f);
const cardOf = ai => document.getElementById("ann-" + ai);
const rowElOf = (f, l) => document.getElementById("L-" + f + "-" + l);      // head-side line
const delRowElOf = (f, l) => document.getElementById("D-" + f + "-" + l);   // deleted line (merge-base numbering)
const fileIdxOf = el => { const f = el.closest(".file"); return f ? +f.id.slice(5) : null; };
const annIdxOf = card => +card.id.slice(4);
// Hover key for a row: head line number, or "d"+base line number for deleted rows.
const rowLineKey = tr => (tr.id ? (tr.id[0] === "D" ? "d" : "") + tr.id.split("-")[2] : null);

// ----- canonical anchor index -----
// The DOM is static, so resolve every anchor to its elements once. ANCHORS is
// the forward map (anchor -> file section + rows); irefsByLine / irefsByFile
// invert it (diff location -> anchor phrases in the panel). ROWS_BY_ANN maps
// each annotation to every row carrying it (data-anns is the ground truth).
const ANCHORS = RANGES.map(anns => anns.map(r => {
  const fileEl = r.file === null ? null : fileElOf(r.file);
  if (!fileEl) return null;
  const rows = r.all ? [] : [
    ...r.lines.map(l => rowElOf(r.file, l)),
    ...(r.b || []).map(l => delRowElOf(r.file, l)),
  ].filter(Boolean);
  return { all: !!r.all, fileEl, rows };
}));

const irefsByLine = new Map(); // "fileIdx:lineKey" -> [iref]
const irefsByFile = new Map(); // fileIdx -> [iref] (whole-file anchors)
const mapPush = (map, k, v) => { const a = map.get(k); if (a) a.push(v); else map.set(k, [v]); };
document.querySelectorAll(".iref").forEach(el => {
  const r = RANGES[+el.dataset.ann][+el.dataset.anchor];
  if (r.file === null) return;
  if (r.all) mapPush(irefsByFile, r.file, el);
  else {
    r.lines.forEach(l => mapPush(irefsByLine, r.file + ":" + l, el));
    (r.b || []).forEach(l => mapPush(irefsByLine, r.file + ":d" + l, el));
  }
});

const ROWS_BY_ANN = TITLES.map(() => []);
diffEl.querySelectorAll("tr[data-anns]").forEach(tr =>
  tr.dataset.anns.split(" ").forEach(ai => ROWS_BY_ANN[+ai].push(tr)));
const rowsForAnn = ai => ROWS_BY_ANN[ai] || [];

// Diff-side targets of one anchor: its rows, or the whole file section for a
// whole-file anchor (so dimming keeps the entire file lit, not just its header).
function anchorTargets(ai, ri) {
  const a = ANCHORS[ai][ri];
  return !a ? [] : a.all ? [a.fileEl] : a.rows;
}

function flashAndScroll(rows) {
  if (!rows.length) return;
  rows[0].scrollIntoView({ block: "center", behavior: "smooth" });
  rows.forEach(el => el.classList.remove("flash"));
  void rows[0].offsetWidth; // one reflow to restart the animation
  rows.forEach(el => el.classList.add("flash"));
}

// ----- focus mode: show only a chosen set of rows -----
let focusKey = null;

function unfocus() {
  focusKey = null;
  document.body.classList.remove("focused", "rows-only");
  diffEl.querySelectorAll(".keep").forEach(e => e.classList.remove("keep"));
  setActiveCard(null);
}

// rowLevel: hide everything but the rows themselves (Show uncovered); without
// it, the rows' whole files stay visible for context (annotation focus).
function enterFocus(rows, label, key, rowLevel) {
  if (focusKey === key) { unfocus(); return; }
  if (!rows.length) return; // nothing to focus — keep whatever focus is active
  unfocus();
  focusKey = key;
  rows.forEach(el => {
    el.classList.add("keep");
    const hunk = el.closest(".hunk");
    if (hunk) hunk.classList.add("keep");
    const file = el.closest(".file");
    if (file) file.classList.add("keep");
  });
  document.body.classList.add("focused");
  if (rowLevel) document.body.classList.add("rows-only");
  document.getElementById("focuslabel").textContent = label;
  rows[0].scrollIntoView({ block: "center" });
}

function setActiveCard(ai, scroll) {
  document.querySelectorAll(".card.active").forEach(c => c.classList.remove("active"));
  if (ai === null) return;
  const card = cardOf(ai);
  if (!card) return;
  card.classList.add("active");
  if (scroll) card.scrollIntoView({ block: "center", behavior: "smooth" });
}

function focusAnn(ai) {
  enterFocus([...rowsForAnn(ai)], "Showing only files for: “" + TITLES[ai] + "”", "ann-" + ai);
  if (focusKey === "ann-" + ai) setActiveCard(ai, false);
}

function flashRows(ai, ri) {
  const a = ANCHORS[ai][ri];
  if (!a) return;
  if (focusKey !== null && focusKey !== "ann-" + ai) unfocus();
  // Jumping into a reviewed (minimized) file reveals it until its check toggles.
  if (a.fileEl.classList.contains("reviewed")) a.fileEl.classList.add("peek");
  // Whole-file anchors — and line anchors whose lines aren't rendered in any
  // hunk — jump to the file itself rather than doing nothing.
  if (a.all || !a.rows.length) { a.fileEl.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
  flashAndScroll(a.rows);
}

// ----- bidirectional hover highlighting -----
// Hovering a bullet highlights all its anchors' lines; hovering a single
// anchor phrase narrows to just its lines. Hovering annotated diff rows (or a
// whole-file-anchored file header) highlights the corresponding bullet(s).
// Highlight state lives in the DOM classes themselves (.hl / .has-hl) —
// there's no shadow list to fall out of sync.
let lastHover = null; // element the current highlight was computed for

function setHl(els) {
  document.querySelectorAll(".hl").forEach(e => e.classList.remove("hl"));
  document.querySelectorAll(".has-hl").forEach(e => e.classList.remove("has-hl"));
  const hlEls = els.filter(Boolean);
  hlEls.forEach(e => e.classList.add("hl"));
  const containers = [...new Set(hlEls.map(e => e.closest(".file") || e.closest(".card")).filter(Boolean))];
  containers.forEach(e => e.classList.add("has-hl"));
  // Dim the pane the highlights live in (the counterpart of where the mouse
  // is). toggle(name, force) is a no-op when the state is unchanged, so
  // dragging across rows doesn't re-trigger page-wide style invalidation.
  document.body.classList.toggle("dim-diff", containers.some(e => e.classList.contains("file")));
  document.body.classList.toggle("dim-panel", containers.some(e => e.classList.contains("card")));
}

panelEl.addEventListener("mouseover", e => {
  const iref = e.target.closest(".iref");
  const li = e.target.closest(".body li");
  const target = iref || li;
  if (target === lastHover) return;
  lastHover = target;
  const irefs = iref ? [iref] : li ? [...li.querySelectorAll(".iref")] : [];
  setHl(irefs.flatMap(el => anchorTargets(+el.dataset.ann, +el.dataset.anchor)));
});

diffEl.addEventListener("mouseover", e => {
  const tr = e.target.closest("tr[data-anns]");
  const fhead = tr ? null : e.target.closest(".fhead");
  const target = tr || fhead;
  if (target === lastHover) return;
  lastHover = target;
  let irefs = [];
  if (tr) {
    const f = fileIdxOf(tr);
    const key = rowLineKey(tr);
    irefs = [...(key !== null ? irefsByLine.get(f + ":" + key) || [] : []), ...(irefsByFile.get(f) || [])];
  } else if (fhead) {
    irefs = irefsByFile.get(fileIdxOf(fhead)) || [];
  }
  setHl(irefs.flatMap(el => [el, el.closest("li")]));
});

for (const pane of [panelEl, diffEl]) {
  pane.addEventListener("mouseleave", () => { lastHover = null; setHl([]); });
}

// ----- go-to-definition -----
// Identifier tokens matching a module-level definition are links. Jump to the
// definition's row when it's rendered and visible in the diff; otherwise pop
// up its snippet (the definition may live outside the changed hunks, in a
// reviewed-minimized file, or outside the current focus).
let defPop = null;
function dismissDefPop() { defPop?.remove(); defPop = null; }

function gotoDef(el, e) {
  dismissDefPop();
  const candidates = SYMBOLS[el.dataset.sym] || [];
  if (!candidates.length) return;
  // Prefer a definition in the same file (waves define same-named symbols).
  const myFile = fileIdxOf(el); // null for links inside the popover snippet
  const t = (myFile !== null && candidates.find(c => c.file === myFile)) || candidates[0];
  const row = rowElOf(t.file, t.line);
  if (row) {
    const fileEl = row.closest(".file");
    if (fileEl && fileEl.classList.contains("reviewed")) fileEl.classList.add("peek");
    if (!row.offsetParent && document.body.classList.contains("focused")) unfocus();
    if (row.offsetParent) { flashAndScroll([row]); return; }
  }
  defPop = document.createElement("div");
  defPop.className = "defpop";
  const head = document.createElement("div");
  head.className = "defpop-head";
  head.textContent = FILE_PATHS[t.file] + ":" + t.line + " ";
  const note = document.createElement("span");
  note.textContent = "— definition not in the diff view";
  head.appendChild(note);
  const pre = document.createElement("pre");
  pre.innerHTML = t.snippet; // generator-escaped highlight markup
  defPop.append(head, pre);
  document.body.appendChild(defPop);
  const pad = 8, w = defPop.offsetWidth, h = defPop.offsetHeight;
  defPop.style.left = Math.min(e.clientX + pad, window.innerWidth - w - pad) + "px";
  defPop.style.top = (e.clientY + h + pad * 2 > window.innerHeight ? e.clientY - h - pad : e.clientY + pad) + "px";
}

// ----- reviewed state -----
// Source of truth: the set of reviewed files (persisted as [path, blobHash]
// pairs, so a check only restores while the file's content is unchanged) plus
// explicit checks for annotations that anchor no files (e.g. the overview),
// persisted by content hash so retitling or rewriting one resets its check.
// An annotation with files is reviewed iff ALL its files are reviewed, so the
// two cascade rules can't disagree.
const ANN_FILES = RANGES.map(anns => [...new Set(anns.map(r => r.file).filter(f => f !== null))]);
let saved = {};
try { saved = JSON.parse(storage.get(STORE_KEY) || "{}") || {}; } catch { /* corrupted store */ }
const reviewedFiles = new Set((Array.isArray(saved.files) ? saved.files : [])
  .filter(p => Array.isArray(p) && p.length === 2)
  .map(([p, h]) => { const i = FILE_PATHS.indexOf(p); return i >= 0 && FILE_HASHES[i] === h ? i : -1; })
  .filter(i => i >= 0));
const explicitAnns = new Set((Array.isArray(saved.anns) ? saved.anns : [])
  .map(k => ANN_KEYS.indexOf(k)).filter(i => i >= 0));

function saveReviewed() {
  storage.set(STORE_KEY, JSON.stringify({
    files: [...reviewedFiles].map(i => [FILE_PATHS[i], FILE_HASHES[i]]),
    anns: [...explicitAnns].map(i => ANN_KEYS[i]),
  }));
}

function annReviewed(ai) {
  return ANN_FILES[ai].length ? ANN_FILES[ai].every(fi => reviewedFiles.has(fi)) : explicitAnns.has(ai);
}

function renderReviewed() {
  FILE_PATHS.forEach((_, fi) => {
    const el = fileElOf(fi);
    if (!el) return;
    const on = reviewedFiles.has(fi);
    el.classList.toggle("reviewed", on);
    el.querySelector(".fcheck").classList.toggle("on", on);
  });
  TITLES.forEach((_, ai) => {
    const on = annReviewed(ai);
    const card = cardOf(ai);
    card.classList.toggle("reviewed", on);
    card.querySelector(".acheck").classList.toggle("on", on);
  });
  const ra = TITLES.filter((_, ai) => annReviewed(ai)).length;
  document.getElementById("revcount").textContent =
    "reviewed: " + reviewedFiles.size + "/" + FILE_PATHS.length + " files · " + ra + "/" + TITLES.length + " annotations";
}

function setFileReviewed(fi, on) {
  if (on) reviewedFiles.add(fi); else reviewedFiles.delete(fi);
  fileElOf(fi)?.classList.remove("peek");
}

function toggleFileReviewed(fi) {
  setFileReviewed(fi, !reviewedFiles.has(fi));
  saveReviewed(); renderReviewed();
}

function toggleAnnReviewed(ai) {
  const on = !annReviewed(ai);
  if (ANN_FILES[ai].length) ANN_FILES[ai].forEach(fi => setFileReviewed(fi, on));
  else if (on) explicitAnns.add(ai); else explicitAnns.delete(ai);
  saveReviewed(); renderReviewed();
}

renderReviewed();

// ----- line numbers (hidden by default; the toggle persists) -----
const NUMS_KEY = "annotated-review:linenums";
function applyLinenums() { document.body.classList.toggle("linenums", storage.get(NUMS_KEY) === "1"); }
applyLinenums();

// ----- one delegated click dispatch -----
// Ordered: first matching selector wins, which encodes priority explicitly.
// Definition links come before the popover swallow so the snippet's own def
// links stay clickable; other clicks inside the popover keep it open.
const CLICK_HANDLERS = [
  ["a.def", gotoDef],
  [".defpop", () => {}],
  [".mark", el => setActiveCard(+el.dataset.ann, true)],
  [".iref:not(.dead)", el => flashRows(+el.dataset.ann, +el.dataset.anchor)],
  [".fcheck", el => toggleFileReviewed(+el.dataset.file)],
  [".acheck", el => toggleAnnReviewed(+el.dataset.ann)],
  ["#unfocus", () => unfocus()],
  ["#showunc", () => {
    const unc = diffEl.querySelectorAll(".unc"); // rows, plus hunkless-file notes
    enterFocus([...unc], "Showing only changes no annotation covers (" + unc.length + ")", "unc", true);
  }],
  ["#togglenums", () => {
    if (storage.get(NUMS_KEY) === "1") storage.remove(NUMS_KEY);
    else storage.set(NUMS_KEY, "1");
    applyLinenums();
  }],
  ["tr[data-anns]", el => setActiveCard(+el.dataset.anns.split(" ")[0], true)],
  [".card", (el, e) => { if (!e.target.closest("a")) focusAnn(annIdxOf(el)); }],
];

document.addEventListener("click", e => {
  if (defPop && !e.target.closest(".defpop, a.def")) dismissDefPop();
  for (const [sel, fn] of CLICK_HANDLERS) {
    const el = e.target.closest(sel);
    if (el) { fn(el, e); return; }
  }
});
document.addEventListener("keydown", e => { if (e.key === "Escape") { unfocus(); dismissDefPop(); } });
