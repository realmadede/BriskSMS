# CLAUDE.md — Claude Code Guidelines (Skarp Framework)

Behavioral guidelines to reduce common LLM coding mistakes in BriskSMS, derived from Andrej Karpathy's observations.

**Tradeoff:** Biased toward **caution over speed**.

---

## 1. Think Before Coding
- **State assumptions explicitly**: Never guess on financial logic or data models.
- **Surface tradeoffs**: Present alternatives when design decisions affect maintainability or latency.
- **Stop when confused**: Halt and ask when requirements or context are contradictory.

## 2. Simplicity First
- **No speculative features**: Build only what is needed.
- **No single-use abstractions**: Avoid generic wrappers for one-off functions.
- **The Senior Engineer Smell Test**: Simplify overcomplicated solutions.

## 3. Surgical Changes
- **Zero orthogonal edits**: Touch only files and lines directly relevant to the task.
- **Clean up your own orphans**: Delete unused imports or helpers created during your turn.
- **The Diff Test**: Every line in git diff must trace directly to the user's prompt.

## 4. Goal-Driven Execution
- Formulate clear verification criteria for each change.
- Run tests (`npm test` / `bun test`) and linters before reporting completion.
