# Contributing to BriskSMS

Thank you for contributing to **BriskSMS**. As a commercial financial SaaS platform, we hold our codebase to strict engineering, security, and testing standards.

---

## 1. Code of Conduct & Standards

All contributors must adhere to:
- Production-oriented, security-first engineering. No prototypes or hackathon shortcuts.
- [AGENTS.md](../AGENTS.md) for overarching repository governance.
- [API Conventions](./standards/API_CONVENTIONS.md) and [Database Conventions](./standards/DATABASE_CONVENTIONS.md).
- [Coding Standards](./standards/CODING_STANDARDS.md) and [Testing Standards](./standards/TESTING_STANDARDS.md).

---

## 2. Git Workflow & Commit Guidelines

1. **Branching Strategy:**
   - Feature branches: `feat/<module-name>-<short-description>` (e.g., `feat/payment-mpesa-parser`).
   - Fix branches: `fix/<issue-description>` (e.g., `fix/device-qr-expiry`).
   - Chore/Docs: `docs/<description>` or `chore/<description>`.
2. **Commit Signing:**
   - All commits must be cryptographically signed with your registered GPG or SSH key (`git commit -S`).
3. **Commit Messages:**
   - Follow the Conventional Commits specification:
     - `feat(payment): add versioned Vodacom M-Pesa parser adapter`
     - `fix(device): resolve race condition in token revocation cache`
     - `test(parser): add real-world test cases for Mixx by Yas`
     - `docs(prd): update acceptance criteria for partial invoice settlements`

---

## 3. Pull Request (PR) Requirements

Before submitting a Pull Request, ensure:
1. `npm run lint` passes with 0 errors and 0 warnings.
2. `npm run build` succeeds cleanly across all workspace packages and apps.
3. `npm run test` passes with 100% success rate.
4. If modifying financial or ledger code, corresponding invariant tests are included.
5. No credentials, tokens, or private environment variables are included in the diff.

