import { randomUUID } from 'crypto';
import { hash } from '../document-contract';
import { BaselineRequest2, Receipt2, validateBaselineRequest, validateBaselineReceipt, verifyBaselineRuntimeEvidence, TrustedRuntimeProvenance } from '../baseline-protocol';
import { BaselineHardenedRunner, rehearseBaselineProtocol } from '../baseline-hardened-runner';
const h = (c = 'a') => c.repeat(64);
export function protocolFixture() {
    const manifest: BaselineRequest2['manifest'] = { protocol: 2, imageDigest: 'sha256:' + h('d'), runtime: 'runsc', dependencyHash: h('e'), sourceHash: h('b'), sourceLocksHash: h('c'), runnerHash: h('f'), executables: { node: '/opt/anka/bin/node' }, dependencyLayout: 'NONE', network: 'NONE', source: 'READONLY', measurementHash: h('1') };
    const runtimeProfileHash = hash(manifest);
    const plan: BaselineRequest2['plan'] = { commands: [{ profileId: 'VAL-A', repositoryId: 'repo', baseline: 'a'.repeat(40), runtimeProfileHash, budgetProfileHash: h('2'), id: 'CMD-A', criterionId: 'AC-A', argv: ['node', '--test', 'test.cjs'], cwd: '.', timeoutMs: 1000 }], limits: { totalTimeoutMs: 1000, memoryMiB: 64, workMiB: 32, tmpMiB: 16, stdoutBytes: 64, stderrBytes: 64 }, executionOrder: 'SEQUENTIAL_PROFILES' };
    const budgetProfile={measurementHash:manifest.measurementHash,limits:{...plan.limits},hash:''};
    budgetProfile.hash=hash({measurementHash:budgetProfile.measurementHash,limits:budgetProfile.limits});
    plan.commands[0]!.budgetProfileHash=budgetProfile.hash;
    const q: BaselineRequest2 = { protocol: 2, purpose: 'BASELINE_VALIDATION', nonce: randomUUID(), operationId: randomUUID(), jobId: 'anka-baseline-' + randomUUID(), bindingHash: h(), planHash: hash(plan), plan, profiles:[{profileId:'VAL-A',budgetProfile}], snapshot: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), sourceHash: h('b'), snapshotHash: h('c'), exclusionPolicyHash: h('d'), sourceLocksHash: h('c') }, manifest, runtimeProfileHash };
    const c = q.plan.commands[0]!;
    const r: Receipt2 = { protocol: 2, requestHash: hash(q), nonce: q.nonce, operationId: q.operationId, jobId: q.jobId, results: [{ profileId: c.profileId, repositoryId: c.repositoryId, id: c.id, criterionId: c.criterionId, exitCode: 0, signal: null, timedOut: false, outputLimitCause: null, stdout: 'ok', stderr: '', measurements: { wallMs: 10, cpuMs: 5, rssBytes: 1024, tmpBytes: 0, workBytes: 0, stdoutBytes: 2, stderrBytes: 0, oomKilled: false, sourceWriteAttempted: false } }], measurements: { wallMs: 12, cpuMs: 6, rssBytes: 2048, tmpBytes: 0, workBytes: 0, sourceUnchanged: true, dependencyUnchanged: true, descendantsRemaining: 0 }, cleanup: { jobId: q.jobId, nonce: q.nonce, confirmed: true, mountsReleased: true, descendantsRemaining: 0 } };
    return { q, r };
}
