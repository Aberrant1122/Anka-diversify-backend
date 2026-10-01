# Documentation Authority Runbook

## 1. Purpose and Phase-0 Scope

Phase 0 Documentation & Specs produces an immutable, reviewable technical specification from an approved Requirements authority. It enforces bidirectional traceability between Documentation components and upstream requirements, verifies readiness, and supports bounded AI revisions. It does not implement Architecture generation or code generation.

## 2. Artifact Authority

- `ProjectPhaseState.currentArtifactId`: Identifies the latest Documentation artifact (draft or approved).
- `ProjectPhaseState.currentApprovedArtifactId`: Identifies the authoritative human-approved Documentation artifact.
- `ProjectPhaseState.approvalCandidateArtifactId`: Identifies the exact artifact submitted for human approval review.
- Creating an AI revision or manual successor sets `currentArtifactId` to the new DRAFT artifact while preserving `currentApprovedArtifactId` intact. AI operations NEVER promote drafts to approved authority automatically.

## 3. Provenance and Upstream Authority

Every Documentation artifact embeds authoritative provenance in `sourceRequirements`:
- `artifactId`: Exact ID of the approved Requirements artifact used as generation context.
- `version`: Version number of the upstream Requirements artifact.
- `contentHash`: SHA-256 hash of the upstream Requirements canonical structured content.

The provider draft cannot emit `sourceRequirements` or `requirementsTraceability`; these are strictly server-owned and derived deterministically during assembly.

## 4. Supported Revision Operations

Phase 0 Documentation supports four distinct AI revision operations:
1. `DOCUMENT_REVISION`: Whole-document modification based on an explicit user instruction.
2. `FEEDBACK_APPLICATION`: Whole-document modification incorporating human review feedback.
3. `SECTION_REVISION`: Bounded modification targeting a single valid section based on user instructions.
4. `SECTION_REGENERATION`: Bounded recreation of a single valid section derived from authoritative upstream requirements and context.

Each operation maintains distinct `WorkflowOperation` logging, prompt versions, change kinds, and audit semantics, but all operations require the provider to return a complete `DocumentationProviderDraft`. Partial documents and JSON patches are forbidden.

## 5. Requirements Staleness and Explicit Rebase Policy

When an AI revision begins:
- If base Documentation references the CURRENT approved Requirements: all four revision operations are permitted.
- If upstream Requirements have advanced to a newer approved artifact:
  - `SECTION_REVISION`, `SECTION_REGENERATION`, and `FEEDBACK_APPLICATION` FAIL CLOSED (`PLANNING_ARTIFACT_INVALID`). Stale partial edits cannot guarantee cross-document consistency.
  - `DOCUMENT_REVISION` is rejected unless the caller supplies an explicit `rebaseToCurrentRequirements: true` flag.
  - When explicitly rebased, Tx A binds the new approved Requirements authority, Tx B stamps the new `sourceRequirements` provenance, re-derives traceability, and the resulting artifact remains an unapproved DRAFT requiring human approval.

## 6. Deterministic Diff, Stable IDs, and No-Op Protection

- **Deterministic Diff**: Successor artifacts are compared against their base artifact using canonical AST/JSON comparison. Diff is authoritative; LLM-written summaries are discarded.
- **Stable IDs**: Entities retained across revisions must preserve their canonical IDs. Items cannot move across root arrays, and delete/re-add churn is rejected (`PLANNING_ARTIFACT_INVALID`).
- **No-Op Protection**: An ordinary revision with no provider-owned canonical changes fails with `PLANNING_REVISION_NO_CHANGES` (HTTP 422). An explicit whole-document rebase that changes authoritative `sourceRequirements` is material even if provider-owned fields are unchanged; it creates a DRAFT successor with server-derived traceability.

## 7. Section Dependency Closure

Section operations enforce the frozen section dependency closure table:
- `overview` → `overview`
- `systemActors` → `systemActors`, `features`, `permissionRules`
- `features` → `features`, `apiContracts`, `businessRules`, `permissionRules`, `errorBehaviors`, `edgeCases`
- `apiContracts` → `apiContracts`, `dataEntities`, `permissionRules`, `errorBehaviors`, `edgeCases`
- `dataEntities` → `dataEntities`, `apiContracts`, `businessRules`, `edgeCases`
- `businessRules` → `businessRules`, `features`, `errorBehaviors`, `edgeCases`
- `permissionRules` → `permissionRules`, `features`, `apiContracts`, `errorBehaviors`
- `errorBehaviors` → `errorBehaviors`, `apiContracts`
- `edgeCases` → `edgeCases`
- `unresolvedQuestions` → `unresolvedQuestions`

Changes outside the target section and its allowed dependency closure are rejected with `PLANNING_SECTION_SCOPE_VIOLATION` (HTTP 422).

## 8. WorkflowRun, Lease, and Lifecycle Rules

- Documentation AI operations share `ProjectPhaseState(documentation).activeRunId`.
- **Tx A**: Validates current base, verifies lifecycle status, binds context and request fingerprint, acquires the active lease, and creates the `WorkflowRun` under `SERIALIZABLE` isolation.
- **Provider execution**: Runs outside database transactions under the frozen 8,000 output token limit.
- **Tx B**: Re-verifies run lease, re-verifies base currentness and lifecycle, validates provider output, enforces stable IDs, section closures, and no-op checks, persists the immutable successor, and releases the lease.
- **Lifecycle locks**:
  - `DRAFT` / `CHANGES_REQUESTED`: Revisions permitted.
  - `APPROVED`: Revisions permitted (creates new DRAFT successor; approved authority remains unchanged).
  - `AWAITING_APPROVAL`: Revision locked (`PLANNING_ACTION_LOCKED`). AI revisions cannot mutate an in-flight approval candidate behind the reviewer.

## 9. Idempotency, Request Fingerprints, and Replay

- All Documentation operations share the scoped namespace: `documentation:<sha256(raw Idempotency-Key)>`.
- The request fingerprint binds: `projectId`, `operation`, `baseArtifactId`, `baseContentHash`, `sourceRequirements` identity, `targetSectionKey`, instruction/feedback hash, `includeMemory`, and `rebaseToCurrentRequirements`.
- Matching key + matching persisted request identity: Replays the existing run (returning `200` completed, `202` running, or original deterministic error), even if approved Requirements or other mutable authority later changes. Authorization is checked before historical replay.
- Matching key + mismatched fingerprint: Rejects with `PLANNING_IDEMPOTENCY_CONFLICT` (HTTP 409). Raw keys are never stored.
- Usage audit `promptVersion` records the operation-specific version from the run context; initial generation retains its initial-generation version.

## 10. Concurrency, Race Safety, and Failure Handling

- **Human vs AI Race**: If a human creates a successor artifact or edits while an AI revision is executing, Tx B detects `PLANNING_CONTEXT_CHANGED`, releases the phase lease, and prevents persisting a stale artifact.
- **Approval Race**: If an artifact enters `AWAITING_APPROVAL` while an AI revision is running, Tx B detects the lifecycle change and fails closed (`PLANNING_ACTION_LOCKED`).
- **Requirements Change Race**: If upstream Requirements authority changes while an AI revision is executing without explicit rebase, Tx B fails closed (`PLANNING_CONTEXT_CHANGED`).
- **Concurrent AI operations**: Only one operation may hold `activeRunId`. Concurrent attempts receive `PLANNING_GENERATION_IN_PROGRESS` (HTTP 409).

## 11. Architecture Handoff Preflight Contract

Before the Architecture phase may commence, `preflightArchitectureHandoff` deterministically verifies:
1. Requirements authority: `currentApprovedArtifactId` exists, artifact is `APPROVED`, matching schema and renderer versions, non-corrupted content hash and rendered Markdown, and verified non-legacy `PhaseApproval` record.
2. Documentation authority: `currentApprovedArtifactId` exists, artifact is `APPROVED`, matching schema and renderer versions, non-corrupted content hash and rendered Markdown, and verified non-legacy `PhaseApproval` record.
3. Exact Provenance Match: `Documentation.sourceRequirements.artifactId == Requirements.id`, matching `version` and `contentHash`. If Requirements have been re-approved to a newer version without Documentation being re-approved, Documentation is stale and Architecture generation is blocked (`PLANNING_ACTION_LOCKED`).
