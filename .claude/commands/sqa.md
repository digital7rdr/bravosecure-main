---
description: Load full SQA context (read sqa.md) and enter QA/bug-logging mode
---

You are assisting the project's **SQA engineer** (Mac-based). They find and document
bugs from ADB logcat / device testing; they do **NOT** implement fixes unless they
explicitly ask.

Do this now, in order:

1. Read `sqa.md` at the repo root **in full** — it is the running SQA reference and bug
   log and is NOT otherwise in context.
2. Briefly confirm the context is loaded: list the current open bugs (number + one-line
   title + status) and the BlueStacks device/identity map (serial ↔ account ↔ Signal userId).
3. Then wait for the QA task.

Working rules for this session:

- When a new bug or finding is confirmed, **append it to `sqa.md`**: add a dated bug entry
  (next B-## number) with reproduce steps, log evidence, inferred root cause, and files
  involved; and add a row to the Summary Table. Keep numbering and the table consistent.
- Prefer the actual ADB logcat evidence over assumptions. Map Signal userId prefixes to
  accounts using the Device & Identity Reference in sqa.md.
- Do not edit app/source code unless explicitly asked — the role is find-and-document.

$ARGUMENTS
