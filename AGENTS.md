# Trading Tools agent instructions

Before changing, building, or testing this project:

1. Read `README.md` completely.
2. Read `REQUIREMENTS.md` completely.
3. Preserve the invariants in `REQUIREMENTS.md`; do not remove an existing workflow to fix a UI symptom.
4. After every implementation, append the user's request and the work performed to the implementation log in `REQUIREMENTS.md`.
5. Verify data persistence and UI behavior, not only compilation.
6. Use the Node version pinned in `.nvmrc`. Start through the npm scripts so the automatic `better-sqlite3` ABI preflight runs; do not invoke `next` directly.
7. For any market-data source, freshness, persistence, chart-value, or refresh change, read and use `skills/audit-real-market-data/SKILL.md`, including its data contract and audit script.
