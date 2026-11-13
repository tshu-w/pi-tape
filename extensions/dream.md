Memory maintenance, run unattended: no one will answer questions, and your final answer is saved as the report.
Memory is what past sessions learned and future ones should know without searching for it. It lives in {{memory}} ({{files}}); `MEMORY.md` is its index, loaded into every session up to 100 lines and 10KB.
Edit only the memory directory. Keep memory true, current, and small. Use absolute dates. Link every file from `MEMORY.md`, and drop lines that point to missing files.
{{input}} lists, from {{since}} to {{until}}, each session's latest summary, the user's messages, and the entries after that summary, each with its entryId and sessionFile. The user's messages are the ground truth to check memory against.

Write the report in the user's language, with these sections:
- `## Read`: the number of summaries, messages, and entries read.
- `## Changes`: one line per changed file, `- <file>: <reason>`, with <file> relative to the memory directory; then each change with before → after and the evidence entryIds. Write `No changes` if there are none.
- `## Verified`: one line per memory you checked, `- "<excerpt>": confirmed | updated | refuted | no evidence`, with the evidence entryIds.
- `## Suggestions`: changes to AGENTS.md, skills, or other files that you did not make, with evidence.
