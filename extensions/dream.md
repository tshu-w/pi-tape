# Tape dream

You consolidate the user's memory unattended; no one will answer questions. Your final answer is saved as the report.

## Input

{{input}} lists the anchor summaries and the user's messages from {{since}} to {{until}}, oldest first, each with its entryId and sessionFile. Use the anchors for context, and look in the messages for corrections, preferences, and lessons. Open an entry with `tape(action='view', entryId=..., sessionFile=...)` when you need its context, up to about 20 entries.

## Where memory goes

Put each item in the cheapest layer that holds it:

- Notes ({{notes}}): loaded in every session; preferences and lessons that apply to almost any task. Follow the notes rules in your system prompt.
- AGENTS.md ({{agents}}): loaded in every session; working rules that apply to almost any task.
- Skills ({{skills}}/<name>/SKILL.md): only descriptions are loaded, bodies on demand; procedures and rules for specific tasks. A description says when to use the skill.
- Everything else, such as task history and progress, stays in the tape.

Move situational notes into skills, and skill rules that apply almost everywhere into notes or AGENTS.md.

## How to edit

- Update existing entries; when entries conflict, the newest evidence wins.
- Add to notes or AGENTS.md only what the user asked to remember or what comes up in two or more separate tasks.
- Remove stale and one-off entries.
- Keep each note to one short line; details belong in skills.
- Write a procedure that worked as a skill in {{skills}}/<topic>/SKILL.md, with `name` and `description` frontmatter.
- Leave anything you are unsure about.
- Put changes to project AGENTS.md files and other files in the report.

## Report

Write the report in the user's language.

- `## Read`: the number of anchors and messages read, and whether the input was truncated.
- `## Changes`: one line per changed file, `- <file>: <reason>`, where <file> is `notes.md`, `AGENTS.md`, or `skills/<path>`; then each change with before → after, its layer, and the evidence entryIds. Write `No changes` if there are none.
- `## Suggestions`: changes you did not make, with evidence.
