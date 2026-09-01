---
name: review-pr
description: Generate an annotated review page for a GitHub PR. Use when
  given a PR URL or owner/repo#N and asked to review or explain it.
---

The tool lives at TOOL=/path/to/pr-guide (contract: its
docs/REFERENCE.md).
Reconstruct the PR's stated intent from its own record — you are writing in
the author's voice, not critiquing. Don't add reviewer commentary unless the
commit messages or PR body raise it themselves.

1. Fetch the PR: `INFO=$(bun "$TOOL/generate.ts" fetch "<pr>")` — JSON with
   `cacheDir` (local clone), `baseRefOid`, `headRefOid`, `localHeadRef`.
2. Gather intent: `gh pr view "<pr>" --json body,commits`. Read every
   commit's message, not just the PR description — when a later commit
   supersedes an earlier one's design, the later one is the PR's actual
   intent; note the detour only if it explains the final code.
3. Read the diff against the true merge-base:
   `MB=$(git -C "$CACHE_DIR" merge-base "$BASE_SHA" "$LOCAL_HEAD_REF")`,
   then `git -C "$CACHE_DIR" diff "$MB" "$LOCAL_HEAD_REF"`. For anything
   non-obvious, read the surrounding code via
   `git -C "$CACHE_DIR" show <sha>:<path>` — understand the mechanism
   before writing about it.
4. Write `annotations.md` (format: "Annotations format" in the tool's
   docs/REFERENCE.md):
   a short scope note first, then one `##` section per discrete change,
   citing its commit hash(es); an intent paragraph paraphrasing the
   author's why, then bullets anchoring the how into the diff. Anchor at
   the head commit; anchor deleted code at a pre-deletion commit. The
   anchor phrase must be the claim itself, not filler like "here". VERIFY
   every line range with `git -C "$CACHE_DIR" show <sha>:<path> | sed -n
   '<n>,<m>p'` before writing it — a wrong anchor is worse than none. If a
   change has no recorded intent, describe what it does; don't invent why.
5. Generate:
   `bun "$TOOL/generate.ts" --pr "<pr>" --annotations <file> --out <file>`.
   Fix every anchor warning the CLI prints and regenerate. Aim for full
   coverage — an uncovered file usually means a missing annotation, not
   one that deserves none.
6. Reply with a `file://` link to the page and a one-line summary of the PR.
