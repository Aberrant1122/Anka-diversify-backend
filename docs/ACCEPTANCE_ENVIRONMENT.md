# CP0 isolated acceptance environment

The acceptance runner requires an explicitly supplied `CP0_TEST_DATABASE_URL` for a local PostgreSQL test database. It does not use `.env` or `DATABASE_URL` as a fallback, and it rejects remote database hosts. Prisma CLI may report reading `.env`, but the runner passes its validated isolated URL as the child process's `DATABASE_URL`. Use a dedicated disposable local database, for example `postgresql://<test-user>:<test-password>@localhost:5432/<test-db>` with your own values substituted in the environment only. Do not put credentials in this document or the command line.

In PowerShell, set the variable in the current session and run:

```powershell
$env:CP0_TEST_DATABASE_URL = '<your-local-PostgreSQL-test-URL>'
npm run test:cp0:acceptance
```

The runner validates the URL before any migration, SQL, or Jest execution. It accepts only local PostgreSQL hosts and rejects production-like database identifiers. Each suite receives a freshly generated `planning_checkpoint_*` schema. Prisma migrations run in that schema, followed by the suite and automatic `DROP SCHEMA ... CASCADE` cleanup. A migration, test, or cleanup failure makes the command fail. The runner must report successful acceptance only after every schema is removed.

The command runs the CP0 isolated authorization acceptance suite and the PostgreSQL-backed planning requirements lifecycle and planning data foundation suites. Their external S3, OpenAI, GitHub, and terminal service effects are mocked by the tests.
