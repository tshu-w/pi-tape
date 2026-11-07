# pi-tape

[Tape](https://tape.systems/)-style context management for [pi](https://pi.dev).

Requires pi 0.87.0 or later.

## Install

```bash
pi install git:github.com/tshu-w/pi-tape
```

## Concepts

pi-tape keeps two kinds of memory:

- **Tape** — the append-only session history. The model recalls it on demand.
- **Notes** — durable facts the model maintains itself, loaded into every session.

In [tape.systems](https://tape.systems/) terms, notes are a memory view over the tape: each note folds in facts confirmed on the tape, and every edit is itself recorded there, so the tape stays the source of truth.

### Anchors

An anchor marks a topic boundary and carries a summary of the work so far. The model creates one when switching topics, after finishing a major task, or when context runs high. From then on, the model sees the anchor's summary followed by the most recent messages instead of the full history; older messages remain on the tape and can still be recalled.

### Recall

The model searches the tape for earlier messages and tool results, then opens a matching entry to read it in full. Search can span the current branch, the session, sessions in the same working directory, or all sessions. Tape's own searches and views are left out of search results, so earlier lookups do not echo back.

The tool also lists anchors and compaction records, and reports the active boundary, anchor counts, and context usage.

### Compaction

Native compaction and anchors coexist; whichever boundary is later takes effect. While an anchor is active, compaction (manual or automatic) summarizes what the model actually sees rather than the raw history. Other custom compaction handlers are unsupported while an anchor is active. Compaction summaries appear among the tape's records as `compact/YYYYMMDD-HHMMSS`, but they do not become anchors.

## Notes

Notes live in one global file, edited by the model with ordinary file tools:

```
<agent-dir>/tape/notes.md
```

The file is shared across working directories. Older per-directory files (`<agent-dir>/tape/<cwd-slug>/notes.md`) are no longer loaded and are not migrated.

Notes hold short, general preferences and verified lessons; task progress and project-specific instructions stay in history or anchors, and established procedures move to `AGENTS.md` or skills. These conventions are set by the prompt, not enforced by code.

Size limits: past 40 lines the model is asked to distill; past 80 lines or 8KB the loaded content is cut off, with an explicit marker.

Alongside the notes, the system prompt lists up to 10 recent anchors from the current working directory. The list is taken once per session so the prompt stays cache-friendly; anchors created during the session appear in the anchor tool's result instead.

## Dream (optional)

Dream periodically consolidates notes, the global `AGENTS.md`, and global skills from your recent anchors and messages. Enable it in the global `settings.json`:

```json
"pi-tape": { "dream": { "enabled": true, "intervalDays": 3, "minAnchors": 10, "model": null } }
```

It runs in the background when a session starts, at most every `intervalDays` days and after `minAnchors` new anchors, with `model` or Pi's default model. When it ends, the session that started it shows its changes, or the next session does. Reports and `notes.md` backups are kept in `<agent-dir>/tape/dream/`; undo other changes with your version control. The prompt is [`extensions/dream.md`](extensions/dream.md).

## Testing

```bash
npm install && npm test
```

## License

[AGPL-3.0](LICENSE)
