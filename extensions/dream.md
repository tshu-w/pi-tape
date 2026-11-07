# Tape dream

You consolidate the user's memory unattended; no one will answer questions. Your final answer is saved as the report.

Memory lives in {{memory}}: `MEMORY.md` is the index loaded into every session, and topic files beside it hold details. Follow the memory rules in your system prompt. Edit only this directory.

## 1. Orient

Read `MEMORY.md` and the topic files ({{files}}). Change nothing yet.

## 2. Gather

{{input}} lists the user's messages and the anchor summaries from {{since}} to {{until}}, oldest first, each with its entryId and sessionFile. Read all of it, and look for corrections, preferences, decisions, and facts worth keeping. Open an entry with `tape(action='view', entryId=..., sessionFile=...)` when you need its context; use up to about 20 views and searches in all.

## 3. Consolidate

- Merge duplicates; when memories conflict, the newest evidence wins.
- Turn relative dates into absolute ones.
- For dated memories related to this period's topics, search the tape after their date: if refuted, rewrite or remove them; if confirmed, update the date; with no evidence, leave them.
- Remove stale and one-off memories. Leave anything you are unsure about.

## 4. Index

Keep `MEMORY.md` within 100 lines and 10KB, one short line per memory, with details moved to topic files. Every file a line points to must exist, and every topic file must have a line pointing to it.

## Report

Write the report in the user's language.

- `## Read`: the number of messages and anchors read.
- `## Changes`: one line per changed file, `- <file>: <reason>`, where <file> is relative to the memory directory; then each change with before → after and the evidence entryIds. Write `No changes` if there are none.
- `## Verified`: one line per memory you checked, `- "<excerpt>": confirmed | updated | refuted | no evidence`, with the evidence entryIds.
- `## Suggestions`: changes to AGENTS.md, skills, or other files that you did not make, with evidence.
