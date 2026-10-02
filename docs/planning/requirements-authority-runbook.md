# Requirements Authority Runbook

## 1. Purpose and Phase-0 scope

Phase 0 turns a human brief into an immutable, reviewable Requirements artifact and supports bounded revisions through explicit approval. It does not generate Documentation, Architecture, or implementation artifacts.

## 2. Artifact authority

`ProjectPhaseState.currentArtifactId` identifies the latest Requirements draft. `currentApprovedArtifactId` identifies the approved Requirements authority and remains unchanged when a later draft is created. `approvalCandidateArtifactId` identifies the exact current artifact submitted for an approval decision.

## 3. Immutable Requirements artifacts

Each version stores the canonical 12-field Requirements object, rendered content, schema and renderer versions, a deterministic content hash, and lineage through `previousVersionId` and `basedOnArtifactId`. Revisions create successors; approved artifacts are never edited in place.

## 4. Supported AI operations

Phase 0 supports `INITIAL_GENERATION`, `DOCUMENT_REVISION`, `FEEDBACK_APPLICATION`, `SECTION_REVISION`, and `SECTION_REGENERATION`. Every operation returns a complete canonical Requirements object; partial documents and JSON Patch are not accepted.

## 5. WorkflowRun states

- `running`: owns the active Requirements lease while provider work occurs outside a database transaction.
- `completed`: atomically references the persisted output artifact.
- `failed`: records a deterministic validation, provider, size, persistence, or stale-recovery failure.
- `conflicted`: records that current authority or concurrent planning state prevented finalization.
- `cancelled`: records that edit authorization disappeared before persistence.

## 6. Lease and stale-run behavior

Requirements operations share one `activeRunId` lease. Transaction A acquires it under serializable isolation, provider work runs outside the transaction, and Transaction B releases it while completing or terminalizing the run. A later request may recover an expired running lease by failing the abandoned run with `PLANNING_STALE_RUN_RECOVERED`. Replaying that abandoned key before another request performs recovery may continue returning `202`.

## 7. Idempotency and deterministic replay

All Requirements operations share one hashed idempotency namespace. The request fingerprint binds normalized request content and operation authority, but not the deployed prompt version. A matching key reuses the persisted run and never calls the provider again. Completed runs replay their artifact; typed terminal codes replay deterministic public errors; corrupt or unknown stored codes fail closed as `PLANNING_RUN_INVARIANT` without exposing stored messages.

## 8. Section dependency closure

Section operations bind a canonical `targetSectionKey` and its snapshotted dependency closure. Only those root sections may change. The backend computes the full-document diff and rejects changes outside the closure.

## 9. Stable-ID and cross-root reclassification rules

Continuing concepts retain stable IDs. An existing ID cannot move between canonical root sections, and an unchanged entity cannot be removed and reintroduced under a different ID. Cross-root reclassification is rejected deterministically.

## 10. Readiness versus approval

Readiness is a deterministic evaluation of a draft. `ready: true` only means the artifact has no readiness blockers; it does not approve the artifact, alter `currentApprovedArtifactId`, or create a `PhaseApproval`.

## 11. Approval lifecycle

`REQUEST_APPROVAL` binds the exact current artifact, hash, and version as the approval candidate. Only the project owner may approve or request changes. Approval rechecks candidate identity and integrity before setting the immutable approved authority. A later successor returns the phase to an unapproved draft while preserving the earlier `currentApprovedArtifactId`.

## 12. Provider audit, usage, and cost principles

Runs retain sanitized ordered provider attempts, request/response identifiers when supplied, model, finish reason, token usage source, and latency. Aggregate usage includes only provider-authoritative token counts and marks partial or unavailable coverage explicitly. Cost is calculated only when every attempt has complete provider usage and a known model rate; otherwise it remains null.

## 13. Phase-1 handoff contract

Phase 1 must consume `ProjectPhaseState.currentApprovedArtifactId`, never `currentArtifactId`, because a newer unapproved draft may coexist with an earlier approved authority. Its future preflight must verify the approved artifact's project, phase, artifact type, schema version, stored content hash, and recomputed canonical integrity. Phase 1 is not implemented by this checkpoint.

## 14. Deferred limitations

The `ROADMAP_PLANNING` route retains its 4,000-token output cap. Canonical text normalization retains the existing lone-carriage-return behavior. Same-key replay of an unrecovered stale running run may return `202` until a later request performs lease recovery. These are documented limitations, not Phase-0 blockers.
