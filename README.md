# pi-tape

Context and memory for [Pi](https://pi.dev), built on the session [tape](https://tape.systems/): anchors keep context small, search recalls any session, and memory carries what matters into the next one.

- **Anchors**: The model marks a topic boundary with a summary; from then on it sees the summary and recent messages, and older history stays searchable.
- **Recall**: The model searches earlier messages and tool results across sessions and reads any entry with the messages around it.
- **Memory**: The model keeps what future sessions need, such as your preferences, lasting project facts, and where things live. Its index loads into every session and details load on demand; `AGENTS.md` and skills stay yours.
- **Dream** (optional): Memory is consolidated in the background: duplicates merged, dated memories re-checked against later sessions, stale ones removed.

## Install

```bash
pi install git:github.com/tshu-w/pi-tape
```

Requires Pi 0.87.0 or later.

## Dream

Enable it in the global `settings.json`:

```json
"pi-tape": { "dream": { "enabled": true, "minHours": 24, "minMessages": 30, "model": null } }
```

It runs at most every `minHours` hours, once you have sent `minMessages` messages since the last run. It edits only `<agent-dir>/tape/memory/` and suggests changes to `AGENTS.md` and skills in its report; reports and backups are kept in `<agent-dir>/tape/dream/`. The prompt is [`extensions/dream.md`](extensions/dream.md).

## Limitations

- While an anchor is active, compaction summarizes what the model sees, and other custom compaction handlers are unsupported.

## License

[AGPL-3.0](LICENSE)
