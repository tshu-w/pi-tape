# pi-tape

[Tape](https://tape.systems/)-style context management for [pi](https://pi.dev).

Requires pi 0.81.1 or later.

## Install

```bash
pi install git:github.com/tshu-w/pi-tape
```

## Tools

| Action | Description |
|---|---|
| `anchor` | Create a semantic boundary with a slug and retrospective summary |
| `view` | List anchors and compact records, or display an entry by `entryId` |
| `search` | Find old entries by query, kind, and timestamp filters |
| `info` | Show the active boundary, anchor counts, and context usage |

## Notes

pi-tape manages two kinds of memory:

- **tape** — the immutable history (append-only log). Recalled on demand via `search`/`view`.
- **notes** — mutable durable facts the model maintains itself (state). Injected into the system prompt every turn, right after AGENTS.md.

In [tape.systems](https://tape.systems/) terms, notes are a *memory view* over the tape, materialized as a file: every note originates from a fact on the tape (user feedback, a lesson from a work segment), and the model acts as an incremental reducer that folds new facts into the view as they are confirmed — assembly cost is paid at write time instead of read time. Each fold step is itself recorded on the tape as a normal edit, so the tape remains the source of truth and the derivative never replaces the original facts.

Notes live in plain markdown files that the model edits with standard file tools (no dedicated action):

```
<agent-dir>/tape/notes.md              # global: user/machine-level facts (default)
<agent-dir>/tape/<cwd-slug>/notes.md   # per-project, created lazily for repo-specific facts
```

Conventions (enforced by prompt, not code):

- One fact per bullet line; delete entries that turn out to be wrong.
- Explicit user preferences/corrections are written immediately with a `(user)` prefix.
- Notes are the model's empirical notebook; AGENTS.md remains the human-authored contract. On conflict, AGENTS.md wins. Promoting a note into AGENTS.md is a human action.
- Scope: task state belongs to anchor summaries, project results to project docs, repo-derivable facts to the repo, behavior rules and procedures to AGENTS.md/skills — none of them belong in notes.

Budget: soft limit 150 lines per file (a warning is appended to the injected block); hard cap 400 lines / 16KB (content is truncated with an explicit marker — never silently).

The injected block also lists recent anchor names for the current working directory (up to 10) as recall hooks into the tape. The list is a snapshot taken once per session: creating an anchor never changes the system prompt, so the prompt-cache prefix stays valid across turns. Anchors created during the session are listed in the anchor tool result instead, which survives the context rebuild.

## Recall workflow

Recall follows the grep → read pattern:

1. `search(query=...)` returns bounded previews with entry IDs. Space means AND, `|` means OR. Optional `kinds` and `start`/`end` filters narrow results.
2. `view(entryId=...)` displays the full entry content with line pagination (`offset`/`limit`).

For cross-session recall, search with `scope="cwd"` or `"all"`, then pass the returned `sessionFile` to `view`.

Default search kinds are `message` + `tool_result`; anchors are searchable with `kinds=["anchor"]`. Tape's own tool calls/results are excluded from search indexing to avoid echoing previous searches.

## Implementation notes

- Context is rebuilt from the latest anchor: summary is injected as conversation history, followed by a window of messages kept via pi's compact cut points.
- Native compaction and anchors coexist; the later boundary wins. Manual, threshold, and overflow compaction summarize the effective anchor-projected context, not the raw branch.
- Providers that require a custom stream implementation are unsupported for compaction while an anchor is active; standard provider transports are unaffected.
- Compact summaries appear in `view` and `search` as `compact/YYYYMMDD-HHMMSS` records, but they do not become tape boundaries.

## Testing

```bash
npm install && npm test
```
