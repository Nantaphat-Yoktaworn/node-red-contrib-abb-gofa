# Project memory (portable snapshot)

This is a copy of this project's Claude Code memory, normally stored outside the repo at
`~/.claude/projects/<project-hash>/memory/` (keyed to the local clone's working-directory path,
so it doesn't travel when the repo is cloned elsewhere). These files are copied in here so a
Claude Code session working from a fresh clone — on any machine — has the same accumulated
context: hard-won lessons, decisions, and project history, not just what's in `CLAUDE.md` and
the code itself.

**Start with `MEMORY.md`** — it's the index; each other file is one memory, tagged by type
(`feedback`, `project`, `reference`, `user`) in its frontmatter.

**This is a manual snapshot, not a live sync.** If you're working from the original clone (same
machine, same path) your live `~/.claude/...` memory is authoritative and will drift ahead of
this copy over time. If you're on a fresh clone (new machine, or a colleague), this folder is
your only source of that history — read it. Worth re-syncing this folder from live memory
periodically (or whenever a project-notable memory is added) so clones don't go stale.
