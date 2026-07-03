# AGENTS.md

## Docs stay in sync with code

When changing code, update the affected docs in the same commit:

- `README.md` — user-facing behavior: tool table, workflows, implementation notes
- Tool schema `description` / `promptGuidelines` in `extensions/index.ts` — the model-facing contract
- The file header comment in `extensions/index.ts` — design-level invariants

## Conventions

- Code, comments, and commit messages in English
- Commit style: Conventional Commits (`feat(tape): ...`, `fix(tape): ...`)
- Keep tool outputs bounded: search returns previews, full content goes through `view(entryId)` pagination
