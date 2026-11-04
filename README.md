# pi-tape

[Tape](https://tape.systems/)-style context management for [pi](https://pi.dev).

Requires pi 0.87.0 or later.

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
- **notes** — mutable durable facts the model maintains itself (state). Injected as a dedicated system-prompt section each turn.

In [tape.systems](https://tape.systems/) terms, notes are a *memory view* over the tape, materialized as a file: every note originates from a fact on the tape (user feedback, a lesson from a work segment), and the model acts as an incremental reducer that folds new facts into the view as they are confirmed — assembly cost is paid at write time instead of read time. Each fold step is itself recorded on the tape as a normal edit, so the tape remains the source of truth and the derivative never replaces the original facts.

Notes live in one global markdown file that the model edits with standard file tools (no dedicated action):

```
<agent-dir>/tape/notes.md
```

This file is loaded across working directories. Old `<agent-dir>/tape/<cwd-slug>/notes.md` files are no longer loaded; existing files remain untouched, with no automatic migration.

Conventions (enforced by prompt, not code):

- One short entry per line; update related entries instead of appending duplicates.
- Record general user preferences and verified facts or lessons; label machine- or project-specific entries.
- Instructions or corrections about a particular task or project stay in session history or anchors, as do task progress, unverified findings, and anything of unclear scope.
- Established procedures move to AGENTS.md, skills, or docs, and the note is removed. On conflict, AGENTS.md wins.

Budget: soft limit 40 lines (a warning is appended to the injected block); hard cap 80 lines / 8KB (content is truncated with an explicit marker — never silently).

When [Dream](#dream-optional) is enabled, notes are also consolidated periodically.

The injected block also lists recent anchor names for the current working directory (up to 10) as recall hooks into the tape. The list is a snapshot taken once per session: creating an anchor never changes the system prompt, so the prompt-cache prefix stays valid across turns. Anchors created during the session are listed in the anchor tool result instead, which survives the context rebuild.

## Dream (optional)

Dream periodically consolidates notes, the global `AGENTS.md`, and global skills from your recent anchors and messages. Enable it in the global `settings.json`:

```json
"pi-tape": { "dream": { "enabled": true, "intervalDays": 3, "minAnchors": 10, "model": null } }
```

It runs in the background when a session starts, at most every `intervalDays` days and after `minAnchors` new anchors, with `model` or Pi's default model. When it ends, the session that started it shows its changes, or the next session does. Reports and `notes.md` backups are kept in `<agent-dir>/tape/dream/`; undo other changes with your version control. The prompt is [`extensions/dream.md`](extensions/dream.md).

## Recall workflow

Recall follows the grep → read pattern:

1. `search(query=...)` returns bounded previews with entry IDs. Space means AND, `|` means OR. Optional `kinds` and `start`/`end` filters narrow results.
2. `view(entryId=...)` displays the full entry content with line pagination (`offset`/`limit`).

For cross-session recall, search with `scope="cwd"` or `"all"`, then pass the returned `sessionFile` to `view`.

Default search kinds are `message` + `tool_result`; anchors are searchable with `kinds=["anchor"]`. Tape's own tool calls/results are excluded from search indexing to avoid echoing previous searches.

## Implementation notes

- Context is rebuilt from the latest anchor: summary is injected as conversation history, followed by a window of messages kept via pi's compact cut points.
- Native compaction and anchors coexist; the later boundary wins. Manual, threshold, and overflow compaction summarize the effective anchor-projected context, not the raw branch.
- Native compaction and compatible provider adapters consume the same projected Anchor context, including the request and tool work before a mid-turn cut. Other custom compaction handlers are unsupported while an anchor is active.
- Compact summaries appear in `view` and `search` as `compact/YYYYMMDD-HHMMSS` records, but they do not become tape boundaries.

## Testing

```bash
npm install && npm test
```

## License

[AGPL-3.0](LICENSE)
