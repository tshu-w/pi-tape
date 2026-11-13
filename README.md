# pi-tape

Context compaction, searchable history, and memory across sessions for [Pi](https://pi.dev).

- **Compaction**: Keep a summary and recent messages in context; older history stays searchable.
- **Recall**: Search messages and tool results across sessions, and read entries with nearby conversation.
- **Memory**: Keep preferences, lasting facts, and useful references across sessions. The model updates memory as it works; optional Dream runs review and consolidate it in the background.

## Install

```bash
pi install git:github.com/tshu-w/pi-tape
```

Requires Pi 1.0.0 or later.

## Compaction

Context compacts automatically. The model can also request compaction with `tape(action='compact')`, or you can run `/compact`.

Optionally set an end-of-turn token threshold in the global `settings.json`:

```json
"pi-tape": { "compactAt": 200000 }
```

Pi's compaction and retry settings also apply.

## Memory

Memory lives in `<agent-dir>/tape/memory/`. `MEMORY.md` is the index, loaded into every session; other files hold details that the model reads when needed. The model maintains these files with ordinary file tools during its work.

### Dream

Dream optionally reviews memory against past sessions and consolidates it in the background. Enable it in the global `settings.json`:

```json
"pi-tape": { "dream": { "enabled": true, "minHours": 24, "minMessages": 30, "model": null } }
```

It runs when both conditions are met: `minHours` since the last run started, and `minMessages` user messages since the last successful run. `model` selects a provider/modelId; null uses Pi's default model.

The notice shows memory changes and suggestions for other files, such as `AGENTS.md` and skills. Reports and backups are kept in `<agent-dir>/tape/dream/`. The prompt is [`extensions/dream.md`](extensions/dream.md).

See the [specification](docs/SPEC.md) for the full behavior and configuration.

## License

[AGPL-3.0](LICENSE)
