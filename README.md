# pi-tape

[Tape](https://tape.systems/)-style context management for [pi](https://pi.dev).

## Install

```bash
pi install git:github.com/tshu-w/pi-tape
```

## Implementation notes

- Context is rebuilt from the latest anchor: summary is injected as conversation history, followed by a window of messages kept via pi's compact cut points.
- `view` defaults to `scope='cwd'`, listing anchors across all sessions in the same working directory for cross-session discovery.

## Tools

| Action | Description |
|---|---|
| `anchor` | Create a semantic boundary with name and summary |
| `view` | List anchors in current or other sessions |
| `search` | Find old entries by keyword with optional kind filters |
| `info` | Show current tape boundary and context usage |
