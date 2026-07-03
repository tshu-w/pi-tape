# pi-tape

[Tape](https://tape.systems/)-style context management for [pi](https://pi.dev).

## Install

```bash
pi install git:github.com/tshu-w/pi-tape
```

## Tools

| Action | Description |
|---|---|
| `anchor` | Create a semantic boundary with name and summary |
| `view` | List anchors and compact records, or display an entry by `entryId` |
| `search` | Find old entries by query, kind, and timestamp filters |
| `info` | Show current tape boundary and context usage |

## Recall workflow

Recall follows the grep → read pattern:

1. `search(query=...)` returns bounded previews with entry IDs. Space means AND, `|` means OR. Optional `kinds` and `start`/`end` filters narrow results.
2. `view(entryId=...)` displays the full entry content with line pagination (`offset`/`limit`).

Cross-session searches (`scope="cwd"` or `"all"`) render `session=` and `time=` metadata per result; pass `sessionFile` (from search result details) to `view` when opening entries from other sessions.

Default search kinds are `message` + `tool_result`; anchors are searchable with `kinds=["anchor"]`. Tape's own tool calls/results are excluded from search indexing to avoid echoing previous searches.

## Implementation notes

- Context is rebuilt from the latest anchor: summary is injected as conversation history, followed by a window of messages kept via pi's compact cut points.
- Native compaction and anchors coexist — whichever boundary is later effectively wins. An anchor newer than the last compaction rebuilds context from itself; if compaction consumed the anchor message, the compaction summary governs until the next anchor.
- Anchor names are unique per branch; names starting with `compact/` are reserved for compact records.
- `view` defaults to `scope='cwd'`, listing anchors and compact records across all sessions in the same working directory for cross-session discovery. `search` defaults to `scope='session'`.
- Compact summaries appear in `view` and `search` as `compact/YYYYMMDD-HHMMSS` records, but they do not become tape boundaries.
- Date-only search filters cover whole local days: `start=YYYY-MM-DD` begins at 00:00:00 and `end=YYYY-MM-DD` ends at 23:59:59.999.
