a pr, eh sherpa?

In 2026, reviewing code is the bottleneck.
Here's my attempt at vibe-coding tool to make code reviews a bit faster and more effective.
It provides a diff viewer with AI commentary explaining the reasons for each change,
and walking the reviewer through the changes by feature, not just file order.

Generates a self-contained, two-pane HTML guide page for a git diff:
annotations on the left in narrative order, files on the right,
linked both ways.

The premise: an agent writes `annotations.md` — an explanation of *why* each
change was made, with each claim anchored to specific lines — and the tool
renders it beside the diff with coverage tracking, so a reviewer reads the PR
as a narrative rather than an alphabetical file list, and sees exactly which
changed lines no explanation accounts for.

The output is a single HTML file with everything inlined: no server, no
build step — open it straight from disk.

## Using with Claude

This repo is also a Claude Code plugin, self-hosting its own marketplace —
install and update it with Claude Code's plugin commands, no manual cloning
or path-filling required:

```bash
claude plugin marketplace add SnailBones/pr-guide
claude plugin install pr-guide
```

Claude Code installs Bun's dependencies (`diff`, `marked`, `shiki`)
automatically on first use. Update later with:

```bash
claude plugin update pr-guide
```

Then, in any Claude Code session: `/pr-guide <pr-url>`.

### Manual install

To run from a working clone instead (e.g. for local development on the
tool itself):

1. Clone this repo somewhere permanent and run `bun install` in it.
2. Copy the bundled skill into your skills directory:

   ```bash
   cp -r skill/pr-guide ~/.claude/skills/
   ```

   That makes it available in every session; to share it with a team,
   copy it to `<project>/.claude/skills/pr-guide` instead.
3. Edit the copied `SKILL.md` and replace `TOOL="${CLAUDE_PLUGIN_ROOT}"`
   with the path to your clone — that variable only resolves for an
   installed plugin.
4. In any Claude Code session: `/pr-guide <pr-url>`.

## Requirements

- [Bun](https://bun.sh)
- `git`
- The [GitHub CLI](https://cli.github.com/) (`gh`), authenticated, for
  `--pr` / `fetch` mode. Classic mode (local repo, base/head refs) needs
  only git.

## Reference

Running the generator by hand (including classic mode against a local
repo), the `annotations.md` format, and the viewer's semantics (coverage,
drift detection, reviewed-state persistence, …) are documented in
[docs/REFERENCE.md](docs/REFERENCE.md).

## Developing the tool

See [CLAUDE.md](CLAUDE.md) for the verification checklist (types, tests,
regenerating a real PR page, manual browser checks).
