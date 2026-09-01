# Reference

The tool's contract: the CLI, the annotations format, and what the generated
page does. For what the project is and Claude setup, see the
[README](../README.md).

## CLI usage

```bash
bun install                       # once: shiki, marked, diff

# One step, straight from a GitHub PR (clones/fetches into repos/<owner>__<repo>):
bun generate.ts --pr <pr-url | owner/repo#N> --annotations <file> --out <file>

# Resolve + fetch only — prints JSON (number, title, url, state, baseRefName,
# baseRefOid, headRefOid, owner, repo, cacheDir, localHeadRef):
bun generate.ts fetch <pr-url | owner/repo#N>

# Classic mode, against a local repo:
bun generate.ts [base] [head] [--repo <dir>] [--annotations <file>] [--out <file>]
# Defaults: base = origin/HEAD (else main/master), head = HEAD, repo = cwd,
#           annotations = review/annotations.md, out = review/review.html
```

For merged PRs the diff base is the merge commit's first parent (the base
branch as it stood when the PR landed), so a merged PR renders its real diff
instead of an empty one. A deleted base branch falls back to the API's
recorded base commit.

Both modes diff against the merge-base of base and head, so a base branch
that has moved on since the branch point doesn't pull unrelated changes
into the page.

`repos/` (the PR-mode clone cache) and `output/` are created at runtime and
gitignored.

## Annotations format

Markdown. Text before the first `##` renders as a general "Scope" card. Each
`##` section is one annotation: an intent paragraph, then bullets. Anchors are
links binding a phrase to code, at any commit:

```
[phrase](path:12-30@sha)   # lines 12–30 of path, as of that commit
[phrase](path@sha)         # the whole file
```

Paths may contain `@` (scoped packages). Anchors inside code fences or
codespans are examples, not anchors. Anchoring deleted code works: anchor the
old lines at a pre-deletion commit and they land on the diff's deleted rows.

## Viewer features

- **Anchor resolution across commits**: anchor lines are positionally mapped
  (via `git diff -U0`) from the anchor commit to *both* diff sides — head for
  surviving code, merge-base for deleted rows — following renames.
- **Drift detection**: anchor lines with no image on either side are counted,
  badged on the link, totalled in the top bar, and itemized on the CLI.
- **Anchor health warnings**: dead anchors (file not in the diff), anchors
  resolving outside the rendered hunks (rendered dashed; clicking jumps to the
  file), out-of-range line numbers — every failure mode gets a CLI line.
- **Coverage**: every changed row should carry an annotation; deleted rows
  count and are coverable (directly, or inherited from the added rows they
  were replaced by). Binary/rename/mode-only files count as one unit each,
  covered by whole-file anchors. "Show uncovered" focuses the remainder.
- **Overlapping annotations**: a row carried by several annotations shows
  side-by-side stripe bands and one gutter badge per annotation, each
  clickable to its own card. Anchor at whatever granularity fits.
- **Claim ids**: gutter badges show `3b` = annotation 3, bullet b. Letters are
  stamped server-side onto the rendered list items from the same parse walk,
  so badges and cards cannot disagree.
- **Intraline highlighting**: word-level `diff` marks within changed line
  pairs (skipped when a pair is mostly different).
- **Syntax highlighting** (shiki, whole-file so multi-line tokens stay
  correct), with **go-to-definition**: identifier tokens matching a
  module-level definition link to it when the target is unambiguous
  (same file, or defined in exactly one file); definitions outside the
  rendered hunks pop up a snippet.
- **Sticky file headers** while a file scrolls.
- **Reviewed-state persistence**: file checks persist as `[path, blobHash]`
  pairs (a check survives regeneration until the file's content changes);
  anchor-less annotation checks persist by content hash. PR-mode pages key
  storage by `owner/repo#N`, so the base branch advancing doesn't wipe state.
  The page never depends on localStorage being available (Safari denies it on
  `file://`).
- **Bidirectional hover linking** between diff rows and annotation bullets,
  dimming the counterpart pane.
