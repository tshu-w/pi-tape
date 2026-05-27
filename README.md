# pi-tape

Tape-style context construction for [pi](https://pi.dev), inspired by [Tape Systems](https://tape.systems/).

`pi-tape` lets the agent create semantic anchors and lets future turns rebuild context from the latest anchor instead of inheriting all prior conversation.

## Tools

| Tool | Actions |
|---|---|
| `tape` | `anchor`, `search`, `info`, `view` |

## Model

An anchor is a semantic boundary with minimum inherited state:

```ts
{
  name: string,
  summary: string,
}
```

On each LLM call, pi-tape finds the latest anchor and assembles context as:
- Anchor summary (injected as conversation history summary)
- Messages after that anchor

Older history remains append-only in the session file and can be recovered with `tape(action='search')`.

## Install

```bash
pi install git:github.com/tshu-w/pi-tape
```
