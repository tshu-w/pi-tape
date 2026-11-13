# Pi Tape Specification

Pi Tape manages the model's context and memory: it compacts the context, keeps the history searchable, and gives the agent memory across sessions. The tape is the record of the agent's work: append-only, never rewritten, and stored in Pi session files.

References:
- [tape.systems](https://tape.systems/): history is append-only, derivatives never replace original facts, and context is assembled.
- [Effective context engineering for AI agents](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents): compaction and structured note-taking.
- [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory): a small injected index, dreaming that checks notes against transcripts, and transcript search.

## 1. Semantic model

The **tape** is a chronological sequence of entries.

A **compaction** replaces the older part of the conversation with a **summary**, as Pi's compaction does. Each summary replaces the previous one.

Each request's context runs from the most stable part to the most recent:

```
[system prompt, AGENTS.md, skills, tools]
[MEMORY.md]
[summary]
[the recent entries, raw]
```

## 2. Compaction

Between compactions, the context only grows at its end.

A compaction happens when the model asks for one (§3), when a turn ends with the context at an explicitly configured `compactAt` tokens or more (§6), when the context passes Pi's own threshold during a turn (§6), on overflow, or on `/compact`.

Except on overflow, a compaction appends the summarize task to the conversation to reuse the prompt cache. A failed request, or a reply that calls a tool, is retried under Pi's `retry` settings. On overflow, Pi's native compaction and recovery flow is used instead.

The summarize task is a system message followed by the user message `Write the summary now.`; for models that take no system message mid-conversation, both are one user message:

```text
# Context compaction

The conversation above is about to be replaced by a summary you write now. The system prompt will remain. If the conversation starts with an earlier summary, it will be replaced too, so carry over what still matters from it.

Write it so you can keep working as if you remembered everything. Keep the user's requests, constraints, decisions, and corrections, in their words where it matters. Copy names, paths, ids, and numbers exactly. Say what is done and what is still open, and mark what the user has not confirmed as tentative.

Output only the summary. Do not continue the work or call tools.
```

Instructions given with `/compact`, or by an extension that requests a compaction, follow the task as `Additional focus: <instructions>`, as in Pi's own compaction.

## 3. Model-facing tool

### `tape`

description:

Compact the context and search history. `compact` replaces the conversation so far with a summary; `search` finds entries by text, kind, or time; `view` displays an entry, or the entries around it.

promptSnippet:

Compact context and search history

promptGuidelines:

- Use tape(action='compact') when a piece of work is finished or its details no longer need to stay in context.
- Use tape(action='search', query=...) to find what the summary leaves out.

parameters:

- `action`: Action to perform
- `query`: Case-insensitive substring query for search; spaces mean AND, | means OR. Optional when kinds, start, or end is set.
- `kinds`: Entry kinds for search: message, tool_result, tool_call, compaction, branch_summary, or custom (default: message, tool_call, and tool_result).
- `start`: Inclusive start time for search: ISO timestamp or YYYY-MM-DD.
- `end`: Inclusive end time for search: ISO timestamp or YYYY-MM-DD.
- `scope`: Scope for search (default: session). branch uses the current branch; session uses the current Session; cwd uses Sessions in the current working directory; all uses all Sessions.
- `entryId`: Entry ID for view.
- `sessionFile`: Session file of the entry for view (default: the current Session).
- `around`: Entries to list on each side of the entry for view (default: 0, max: 20).
- `limit`: Maximum results for search, or lines to read for view (default: 10 results, all lines).
- `offset`: Number of search results to skip (default: 0), or the line to start from for view (1-indexed, default: 1).

results:

`compact` returns at once; the compaction happens when the turn ends:

```text
Compacting the context after this turn.
```

`search` returns matches newest first. In the current Session, it leaves out the entries that are still in the context:

```text
<entryId>  <label>  YYYY-MM-DD HH:MM
  <preview>
  sessionFile: ~/<file>
```

`<label>` names the entry: `user` or `assistant` for a message, `tool_call <tool>` or `tool_result <tool>` for a tool step, and otherwise its kind. `<preview>` is one line of up to 200 characters, with each run of whitespace, newlines included, shown as one space, taken near the match, or from the start without a query; a cut end shows `…`. `sessionFile` appears for scope `cwd` and `all`. When more remain:

```text
[<N> more results. Use offset=<X> to continue.]
```

When nothing matches:

```text
No matching entries.
```

`view` shows the entry's header line and its text, truncated as Pi's `read` truncates a file:

```text
<entryId>  <label>  YYYY-MM-DD HH:MM
<text>

[Showing lines <a>-<b> of <N>. Use offset=<X> to continue.]
```

With `around`, `view` lists the entry and, on each side of it on its branch, user messages and completed assistant replies without tool calls, oldest first, in the format of search results:

```text
<entryId>  <label>  YYYY-MM-DD HH:MM
  <preview>
```

Tape's own calls and results are not indexed or listed.

errors:

```text
Nothing to compact.
```

```text
`query`, `kinds`, `start`, or `end` is required for search.
```

```text
`entryId` is required for view.
```

```text
No entry <entryId> in this Session.
No entry <entryId> in <sessionFile>.
```

A cancelled call fails with Pi's `Operation aborted`. Invalid parameters fail with a message naming the parameter, such as `` `around` requires `entryId`. ``.

## 4. Memory

Memory is knowledge the agent gains from past sessions and keeps at hand for future ones, so they need not search the history for it. It lives in `<agent-dir>/tape/memory/`: `MEMORY.md` is the index, loaded into every session as the system prompt's `memory` section; other files in that directory hold details, read when needed. The model maintains it with ordinary file tools. Without `MEMORY.md`, the index is empty.

The `memory` section:

```text
Memory from past sessions: what you learned and should know without searching for it, such as the user's preferences and corrections, lasting facts and decisions, and where things live. It is shared by sessions in every project and on every machine.
Read a file in the memory directory when its index line matches the task. Update memory when you learn something worth keeping.
AGENTS.md takes precedence over memory.

<memory path="<path>">
<MEMORY.md>
</memory>
```

Only the first 100 lines or 10 KB of `MEMORY.md` are loaded; past that, the index ends with:

```text
[MEMORY.md is cut at 100 lines/10KB; the rest is not loaded. Move details to other files.]
```

`MEMORY.md` is read for each request; a change reaches the context as an update at its end, and moves into the system prompt at the next compaction. A write or edit that leaves it at 90% of a limit ends with:

```text
[MEMORY.md is at <lines>/100 lines, <size>/10KB; lines past the cap are not loaded. Tidy the index: move details to other files.]
```

## 5. Dream

Dream maintains memory in the background. An interactive session checks at its start and whenever it goes idle, at most once an hour; a run starts once `minHours` have passed since the last run started and the user has written `minMessages` messages since the last successful run (§6). The user's messages are those with the user role; inputs from other Agents are custom messages and do not count. It runs as a separate `pi -p`, one at a time, with `model` or Pi's default model; the prompt below is that process's `dream` section.

It reads the window since the last successful run started, oldest first, each item with its entryId and session file: each session's latest summary in the window, the user's messages in full, and, for the entries after that summary, the assistant's text up to 600 bytes and one line per tool call.

It edits only the memory directory, backing up each file before its first edit; changes it wants elsewhere go into the report as suggestions. Its final answer is the report. The first interactive session idle after the run shows its notice (§7), so the user can review every change; only a run whose agent finished without error counts as successful.

Reports and backups of the last 10 runs are kept in `<agent-dir>/tape/dream/`, with a lock that keeps a second run from starting; a lock older than two hours is ignored.

```text
Memory maintenance, run unattended: no one will answer questions, and your final answer is saved as the report.
Memory is what past sessions learned and future ones should know without searching for it. It lives in <memory> (<files>); `MEMORY.md` is its index, loaded into every session up to 100 lines and 10KB.
Edit only the memory directory. Keep memory true, current, and small. Use absolute dates. Link every file from `MEMORY.md`, and drop lines that point to missing files.
<input> lists, from <since> to <until>, each session's latest summary, the user's messages, and the entries after that summary, each with its entryId and sessionFile. The user's messages are the ground truth to check memory against.

Write the report in the user's language, with these sections:
- `## Read`: the number of summaries, messages, and entries read.
- `## Changes`: one line per changed file, `- <file>: <reason>`, with <file> relative to the memory directory; then each change with before → after and the evidence entryIds. Write `No changes` if there are none.
- `## Verified`: one line per memory you checked, `- "<excerpt>": confirmed | updated | refuted | no evidence`, with the evidence entryIds.
- `## Suggestions`: changes to AGENTS.md, skills, or other files that you did not make, with evidence.
```

## 6. Configuration

Settings live under `"pi-tape"` in the global `settings.json`:

```json
{
  "pi-tape": {
    "dream": { "enabled": false, "minHours": 24, "minMessages": 30, "model": null }
  }
}
```

- `compactAt`: optional context tokens at which a compaction happens when a turn ends (§2). A positive integer, with no default. When absent, only Pi's native threshold and overflow triggers, `/compact`, and `tape(action='compact')` trigger compaction.
- `dream.enabled`: whether dream runs (§5).
- `dream.minHours`, `dream.minMessages`: when it runs (§5). A positive number and a non-negative integer.
- `dream.model`: its model as provider/modelId; null uses Pi's default model.

Pi's compaction settings also apply:
- `compaction.keepRecentTokens`: the latest messages kept at a compaction.
- `compaction.reserveTokens`: room kept for the summary request. Pi also compacts when the context passes its window minus this, so on a small window a compaction can happen below `compactAt`.
- `compaction.enabled`: when false, no compaction happens at `compactAt` or on overflow; `tape(action='compact')` and `/compact` still compact.

Invalid settings produce a startup warning. An invalid `compactAt` disables the turn-end threshold; other invalid settings use their defaults.

## 7. Human interface

A compaction shows as Pi's compaction message; expanded, it shows the summary. Pi shows its compaction indicator for its own triggers and `/compact`. For a compaction at the end of a turn, the working indicator reads `Compacting context... (<interrupt key> to cancel)`, as Pi's does, and Escape cancels the compaction, not the run. A failed compaction shows its error.

The dream notice is an entry outside the model's context, always expanded and styled like Pi's changelog:

```text
────────
Dream

<summary>

<file> — <reason>
<diff>

Suggestions
- <file>: <suggestion and reason>

report: <path>
────────
```

`Dream` and `Suggestions` are bold. `<summary>` is `MEMORY.md <before>→<after> lines · <count> other files`, or `No changes`. Each suggestion names the file and briefly explains the proposed change and why; its evidence stays in the report. The Suggestions section is omitted when there are none. A failed run shows `Failed: <error>` as its summary.
