# GEMINI.md — Gemini CLI & Antigravity Guidelines (Skarp Framework)

Behavioral guidelines to reduce common LLM coding mistakes in BriskSMS, derived from Andrej Karpathy's observations on LLM coding pitfalls.

**Tradeoff:** These guidelines intentionally bias toward **caution over speed**. For non-trivial tasks, adhere strictly to these principles.

---

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before writing or modifying any code in BriskSMS:
- **State assumptions explicitly**: If any requirement, financial rule, or architectural detail is uncertain, ask the user rather than guessing.
- **Surface multiple interpretations**: If a request can be reasonably interpreted in multiple ways, present the options and tradeoffs instead of silently picking one.
- **Push back when warranted**: If a requested change is overengineered or if a significantly simpler, safer path exists, explain why and recommend the alternative.
- **Stop when confused**: If context is missing, behavior is contradictory, or requirements are unclear, halt immediately. Clearly name what is missing or confusing and ask.

---

## 2. Simplicity First

**Write the minimum code that solves the problem. Nothing speculative.**

Combat the natural LLM tendency toward overengineering and premature abstraction:
- **No speculative features**: Implement only what was requested. Do not add unasked-for "flexibility", "configurability", or future-proofing.
- **No single-use abstractions**: Write concrete, inline code before reaching for abstract patterns, helper classes, or generic wrappers that are only used in one place.
- **No defensive bloat**: Do not write complex error handling or fallback cascades for scenarios that are physically or logically impossible within the system.
- **Conciseness matters**: If 200 lines could be written cleanly in 50 lines, rewrite it.
- **The Senior Engineer Smell Test**: Ask yourself: *"Would a senior engineer review this and say it is overcomplicated?"* If the answer is yes, simplify before presenting the result.

---

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When modifying this codebase:
- **Zero orthogonal edits**: Do not "improve", reformat, or restyle adjacent code, comments, imports, or whitespace that are unrelated to the current task.
- **Respect working code**: Do not refactor components, functions, or systems that are not broken or directly in scope.
- **Match existing style**: Follow the project's established conventions, naming patterns, indentation, and idioms.
- **Preserve existing dead code**: If you notice pre-existing unused variables or comments, mention them in your summary—do not delete them unless explicitly instructed.
- **Clean up your own orphans**: If YOUR changes render imports, variables, or functions obsolete, remove them cleanly.
- **The Diff Test**: Every single line in your diff must trace directly and demonstrably to the user's request.

---

## 4. Goal-Driven Execution

**Define success criteria upfront. Loop until verified.**

Transform vague imperative instructions into declarative, verifiable outcomes:
- Instead of *"Add validation"* → *"Write tests for invalid inputs, then implement validation until tests pass."*
- Instead of *"Fix the bug"* → *"Write a reproducing test case, run it to verify failure, then fix the code until the test passes."*
- Instead of *"Refactor module X"* → *"Run test suite to verify baseline, perform refactor, verify test suite passes unchanged."*

For any multi-step task, formulate a concise, verifiable plan:
```text
1. [Step 1 description] → verify: [command / test / check]
2. [Step 2 description] → verify: [command / test / check]
3. [Step 3 description] → verify: [command / test / check]
```

Run test suites, linters, or manual verification commands in your execution environment after each change. Do not declare a task complete until verification criteria pass.
