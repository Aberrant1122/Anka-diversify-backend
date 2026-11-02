# Document workflow release rehearsal

This procedure describes a future authorized release. No production migration,
provider invocation, publication, or deployment is authorized by this file.

## Candidate gates

Pin backend and frontend commit IDs and compare their ancestry with remote main.
Review only the candidate diff, migration files, package lock changes and CI
results at those exact IDs. A cancelled or skipped CI job is not a pass.

Run `npm ci`, `npx prisma generate`, `npx tsc --noEmit`, and
`npm run test:workspace`. The focused runner supplies synthetic auth settings,
blocks inherited provider keys and uses isolated Postgres databases. Its native
Prisma test applies every actual migration in order. `node
scripts/test-planning-transport.cjs` supplies fresh loopback-only schemas for
legacy planning lifecycle checks. PGlite socket multiplexes a single engine;
these checks do not prove independent native PostgreSQL concurrency or deployed
performance. Run staging concurrency checks before release acceptance.

Frontend gates: `npm ci`, `npm test`, `npm run build`. Build must perform
TypeScript checking (`ignoreBuildErrors=false`); configured fonts require
network retrieval. Browser proof must identify the candidate and distinguish a
synthetic provider from a real paid provider invocation.

## Additive migration and preservation

Before an authorized migration, obtain an approved backup and record schema
version, counts/IDs and hashes of legacy projects, planning artifacts,
approvals, runs, repository mappings and documents. Do not print credentials,
provider keys, encrypted credential fields or private document contents in logs.
Restore the backup into separately authorized staging and rehearse first.

The two new migrations add authority documents, heads, exact approvals, runs,
append-only events and durable provider operations. They do not convert legacy
approvals to current authority or delete legacy records. Immutability triggers
and restrictive foreign keys intentionally prevent deleting authority history.

Production startup uses `prisma migrate deploy` and fails on error. It never
falls back to `db push` or bootstrap seeding. Health requires database access
and the new authority/operation schema. Inspect migration status and health
before routing users to the candidate; HTTP 200 alone is not workflow acceptance.

For each migrated project, compare preserved identifiers/counts/hashes and
links. Import legacy planning twice: retain source provenance, produce an
uncertain draft, keep import idempotent and require explicit reconciliation and
new exact approval. Test restart preservation and expired-operation recovery.
Never fabricate an approval to clear a blocker.

## Configuration and acceptance

Require a strong explicit JWT secret and encryption key. Legacy JWTs need
re-login because current active-user/password-bound session versions are
required. Explicit owner bootstrap uses ADMIN_EMAIL and a password of at least
16 characters; no default account is tried or created. Do not rotate existing
production credentials as part of this procedure without authorization.

Use configured production FRONTEND_URL for CORS. Managed repository clones use
ANKA_REPOSITORY_ROOT (default OS temporary managed root); disposable run clones
use ANKA_EXECUTION_ROOT. Existing arbitrary checkout paths are not accepted.
Materialization never resets an existing dirty clone or executes repository
code. Review disk retention and backup policy before production use.

AI generation remains unavailable unless ANKA_WORKSPACE_AI_ENABLED=true and an
existing OpenAI provider configuration is present. Enabling it or running paid
acceptance needs separate authorization. Main and Architecture generation and
code proposals use the existing structured gateway, strict schemas, exact input
snapshots, bounded calls and stale-result rejection. A draft or proposal never
approves documents or writes code.

Acceptance must verify owner isolation, session revocation, immutable versions,
exact Main/Architecture linking, requirement/criterion/unit traceability,
dependency closure, scope/preimage/baseline rejection, stale approvals, failed
checks, same-scope repair lineage, provider interruption and restart. Preserve
historical evidence and unaffected requirement readiness during maintenance.
Declared static contains/not_contains/json/absent checks cannot be presented as
application tests, runtime acceptance or deployment. Command-bearing units also
require successful isolated validation of the exact implementation and command
plan before review. Contract adapters are visibly labelled CONTRACT_TEST and
never establish real runtime acceptance.
Legacy agent/push APIs and unrestricted terminals remain fail-closed.

## Safe rollback

Set ANKA_DOCUMENT_WORKFLOW_ENABLED=false through the separately authorized
configuration process to stop new workflow operations. Disable AI generation if
provider operations must stop. Allow in-flight bounded operations to settle or
record their interruption; do not delete audit records or issue duplicate paid
requests. Preserve additive tables, immutable revisions and evidence.

Roll back only to a security-compatible candidate that understands the additive
schema and keeps legacy coding/terminal/publication paths closed. Reverting to
the original permissive execution paths is unsafe. Do not drop the new tables,
disable immutability triggers or run destructive down migrations to make older
code start. Restore a backup only through an explicitly approved recovery plan,
with a documented reconciliation of any records created after the backup.

## Remaining release limitations

Repository command isolation, dynamic test/repair execution, authority-aware
publication, real provider acceptance and production staging/deployment are
separate unfinished gates. The bounded document/static-check slice must not be
advertised as all phases complete.

## Isolated command and repair adapter

The Docker adapter is disabled unless ANKA_DOCUMENT_SANDBOX_ENABLED=true, an
exact locally reviewed image ID is configured in ANKA_DOCUMENT_SANDBOX_IMAGE
(sha256:<64 hex>) and ANKA_DOCUMENT_SANDBOX_RUNTIME names runsc or kata-runtime.
The daemon must report that runtime and the exact image must carry protocol
label org.anka.sandbox.protocol=1. No image is pulled automatically. Build the
trusted scripts/sandbox/Dockerfile only in a separately approved environment,
with an explicitly reviewed BASE_IMAGE digest and offline dependencies for the
approved toolchain. The minimal image alone does not supply a project's full
dependency tree. Dependency preparation is part of runtime acceptance, never a
host npm install fallback.

Approve argv, cwd, criterion and timeout in Architecture. Maximum four commands
per unit, eight per run and 120 seconds total; commands receive no network,
credentials, Docker socket or writable host mount. Runtime uses non-root UID,
read-only root, temporary work areas, dropped capabilities, no-new-privileges,
CPU/memory/PID and output limits. A digest/runtime configuration is operator
trust, not independent daemon attestation. Real acceptance must inspect the
runtime and test attempted host/network/credential escape, timeout/process-tree
cleanup and project build/test dependency availability. Docker/Podman and native
PostgreSQL executables were absent on this Windows host; the stopped user WSL
distribution was not started or modified.

A durable operation precedes dispatch. Changed authority conflicts a result;
failed checks create an explicit repair successor retaining the same approved
units, failure output and parent implementation evidence. Repair proposals do
not mutate the failed run or enlarge scope. No automatic provider or execution
retry occurs after an uncertain attempt. After five minutes, owner recovery
requires confirmed cleanup of the exact generated sandbox job before marking
validation interrupted. Operator retention/quota policy must bound stored run
clones and snapshots.

## Exact-head publication adapter

ANKA_DOCUMENT_PUBLICATION_ENABLED defaults false and remains false for this
candidate rehearsal. Preparing a candidate only makes a local commit in the
managed run clone. Review its exact diff and all repository heads/targets before
issuing a separate, 15-minute publication approval. Architecture approval is
never publication approval. Dispatch revalidates authority, reviewed diff,
candidate parent/head, owned repository URL and default branch, then verifies
remote default-head drift and uses an atomic create-only lease for a generated
anka/document-\* branch. It cannot overwrite main, push tags, create/merge a PR,
or deploy. Repository credentials stay inside transient Git header config and
are excluded from command argv, URLs and logs.

A partial/uncertain attempt retains receipts and stops. Read-only reconciliation
records current branch observations, never pushes again or overwrites the old
outcome. A second dispatch key cannot bypass the prior attempt. Any manual
recovery requires a separately reviewed exact branch/head action outside this
adapter. Synthetic publisher receipts remain CONTRACT_TEST, never PUBLISHED.
Real GitHub transport/credential acceptance is still an external gate; this
candidate published nothing.

## Independent native PostgreSQL gate

scripts/test-native-postgres.cjs is an opt-in harness for an already available,
synthetic loopback PostgreSQL database only. It never consumes DATABASE_URL,
requires ANKA_LOCAL_REHEARSAL=1 and a separate ANKA_REHEARSAL_DATABASE_URL for
anka_rehearsal:synthetic at 127.0.0.1/anka_rehearsal. It creates a unique schema,
applies actual migrations with psql, races two independent Node/Prisma processes,
requires distinct PostgreSQL backend PIDs and exactly one CAS winner, and drops
only its generated schema. No existing schema or production data is touched.
The new native-concurrency CI job supplies this disposable service. The harness
has source/type/guard checks locally; native engine execution and remote CI
results remain unverified until run on the exact candidate.
