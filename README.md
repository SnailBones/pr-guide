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
2. Symlink the clone into your skills directory. The repo root *is* the
   skill, and the skill finds the tool through `${CLAUDE_SKILL_DIR}`, so
   nothing needs editing:

   ```bash
   ln -s /path/to/pr-guide ~/.claude/skills/pr-guide
   ```

   To share it with a team, link it at `<project>/.claude/skills/pr-guide`
   instead. Don't keep both the plugin and a symlink installed at once —
   the skill would be registered twice.
3. In any Claude Code session: `/pr-guide <pr-url>`.

### Docker Sandboxes

A sandbox created with [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/)
(`sbx`) has its own Claude Code configuration, so a plugin installed on the
host is invisible inside it. Use the shared skills store instead — it is
linked read-only into every sandbox, current and future, at start:

```bash
sbx skills add SnailBones/pr-guide
bun install --cwd "$(sbx skills ls --json | jq -r .store)/pr-guide"
gh auth token | sbx secret set github    # once: lets `gh` authenticate inside sandboxes
```

The store is a plain clone and sandboxes can't write to it, so the
`bun install` runs on the host and reaches every sandbox through the mount.
Repeat those two lines after `sbx skills update pr-guide`. Running sandboxes
pick the skill up on their next start. Inside a sandbox, PR clones go to
`~/.cache/pr-guide` as they do anywhere else.

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
