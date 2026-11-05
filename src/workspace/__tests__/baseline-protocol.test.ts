import { randomUUID } from 'crypto';
import { hash } from '../document-contract';
import { BaselineRequest2, Receipt2, validateBaselineRequest, validateBaselineReceipt, verifyBaselineRuntimeEvidence, TrustedRuntimeProvenance } from '../baseline-protocol';
import { BaselineHardenedRunner, rehearseBaselineProtocol } from '../baseline-hardened-runner';
import { protocolFixture } from './baseline-protocol-fixture';
describe('baseline protocol 2 fail-closed contract', () => {
    it('binds every request field and yields contract evidence only', () => { const { q, r } = protocolFixture(); validateBaselineRequest(q); expect(validateBaselineReceipt(q, r)).toMatchObject({ passed: true, evidenceClass: 'CONTRACT_TEST' }); });
    it.each(['purpose', 'nonce', 'operationId', 'jobId', 'bindingHash', 'planHash', 'runtimeProfileHash'])('rejects request drift: %s', key => { const { q, r } = protocolFixture(); (q as any)[key] = 'forged'; expect(() => validateBaselineReceipt(q, r)).toThrow(); });
    it.each(['commit', 'tree', 'sourceHash', 'snapshotHash', 'sourceLocksHash', 'exclusionPolicyHash'])('rejects snapshot echo drift: %s', key => { const { q, r } = protocolFixture(); (q.snapshot as any)[key] = '1'.repeat(key === 'commit' || key === 'tree' ? 40 : 64); expect(() => validateBaselineReceipt(q, r)).toThrow(); });
    it.each(['imageDigest', 'dependencyHash', 'runnerHash', 'measurementHash', 'executables', 'network', 'source', 'dependencyLayout'])('rejects runtime/dependency drift: %s', key => { const { q, r } = protocolFixture(); (q.manifest as any)[key] = 'forged'; expect(() => validateBaselineReceipt(q, r)).toThrow(); });
    it.each(['profileId', 'repositoryId', 'id', 'criterionId'])('rejects unqualified or mismatched command identity %s', key => { const { q, r } = protocolFixture(); (r.results[0] as any)[key] = 'wrong'; expect(() => validateBaselineReceipt(q, r)).toThrow(); });
    it.each(['missing', 'duplicate', 'unknown', 'nonfinite', 'negative', 'fractional', 'missingMeasurement'])('rejects malformed receipts %s', kind => { const { q, r } = protocolFixture(); if (kind === 'missing')
        r.results = []; if (kind === 'duplicate')
        r.results.push(r.results[0]!); if (kind === 'unknown')
        (r as any).passed = true; if (kind === 'nonfinite')
        r.results[0]!.measurements.wallMs = NaN; if (kind === 'negative')
        r.measurements.tmpBytes = -1; if (kind === 'fractional')
        r.measurements.cpuMs = 0.5; if (kind === 'missingMeasurement')
        delete (r.results[0]!.measurements as any).rssBytes; expect(() => validateBaselineReceipt(q, r)).toThrow(); });
    it.each(['signal', 'timeout', 'overflow', 'oom', 'write', 'source', 'dependency', 'wall', 'cpu', 'rss', 'tmp', 'work', 'descendants', 'cleanup', 'mounts'])('does not pass even exit zero after %s', kind => { const { q, r } = protocolFixture(); const v = r.results[0]!; if (kind === 'signal')
        v.signal = 'SIGKILL'; if (kind === 'timeout')
        v.timedOut = true; if (kind === 'overflow') {
        v.outputLimitCause = 'STDOUT';
        v.measurements.stdoutBytes = 100;
    } if (kind === 'oom')
        v.measurements.oomKilled = true; if (kind === 'write')
        v.measurements.sourceWriteAttempted = true; if (kind === 'source')
        r.measurements.sourceUnchanged = false; if (kind === 'dependency')
        r.measurements.dependencyUnchanged = false; if (kind === 'wall')
        r.measurements.wallMs = 1001; if (kind === 'cpu')
        r.measurements.cpuMs = 1001; if (kind === 'rss')
        r.measurements.rssBytes = 65 * 1048576; if (kind === 'tmp')
        r.measurements.tmpBytes = 17 * 1048576; if (kind === 'work')
        r.measurements.workBytes = 33 * 1048576; if (kind === 'descendants')
        r.measurements.descendantsRemaining = 1; if (kind === 'cleanup')
        r.cleanup.confirmed = false; if (kind === 'mounts')
        r.cleanup.mountsReleased = false; expect(validateBaselineReceipt(q, r).passed).toBe(false); });
    it('rejects forged job cleanup, omitted overflow and output counter lies', () => { for (const mutate of [(r: Receipt2) => r.cleanup.jobId = 'otherjob', (r: Receipt2) => r.results[0]!.measurements.stdoutBytes = 100, (r: Receipt2) => r.results[0]!.measurements.stdoutBytes = 1]) {
        const { q, r } = protocolFixture();
        mutate(r);
        expect(() => validateBaselineReceipt(q, r)).toThrow();
    } });
    it('qualifies repeated command ids by profile and preserves exact order', () => { const { q, r } = protocolFixture(); q.plan.commands.push({ ...q.plan.commands[0]!, profileId: 'VAL-B' });
        q.profiles.push({...q.profiles[0]!,profileId:'VAL-B'}); q.plan.limits.totalTimeoutMs = 2000; q.planHash = hash(q.plan); r.requestHash = hash(q); r.results.push({ ...r.results[0]!, profileId: 'VAL-B' }); r.measurements.wallMs = 25; r.measurements.cpuMs = 12; expect(validateBaselineReceipt(q, r).passed).toBe(true); r.results.reverse(); expect(() => validateBaselineReceipt(q, r)).toThrow(); });
    it('requires actual trusted records and all four attestation checks, not booleans', async () => { const { q, r } = protocolFixture(); let calls: string[] = []; const store: TrustedRuntimeProvenance = { lookup: async () => ({ runtimeProfileHash: q.runtimeProfileHash, measurementHash: q.manifest.measurementHash, dependencyHash: q.manifest.dependencyHash, sourceHash: q.snapshot.sourceHash, sourceLocksHash: q.snapshot.sourceLocksHash, imageDigest: q.manifest.imageDigest, runnerHash: q.manifest.runnerHash, runtime: q.manifest.runtime, budgetProfileHashes: [q.plan.commands[0]!.budgetProfileHash], runtimeAcceptanceRecordId: 'runtime', measurementAcceptanceRecordId: 'measured' }), verify: async (kind, _id, digest) => { expect(digest).toMatch(/^[a-f0-9]{64}$/); calls.push(kind); return false; } }; await expect(verifyBaselineRuntimeEvidence(q, r, { execution: 'exec', cleanup: 'clean' }, store)).rejects.toThrow('TRUSTED_BASELINE_EVIDENCE_REQUIRED'); expect(calls).toEqual(['RUNTIME_ACCEPTANCE']); });
    it('contracts orchestrate sequential fixed executables without host fallback', async () => { const { q, r } = protocolFixture(); const result = await rehearseBaselineProtocol(q, { command: async (c) => { expect(c).toEqual({ executable: '/opt/anka/bin/node', argv: ['--test', 'test.cjs'], cwd: '/source', timeoutMs: 1000 }); return r.results[0]!; }, finish: async () => ({ measurements: r.measurements, cleanup: r.cleanup }) }); expect(result.evidenceClass).toBe('CONTRACT_TEST'); const runner = new BaselineHardenedRunner(); expect(await runner.ready()).toBe(false); await expect(runner.run(q)).rejects.toThrow('BASELINE_RUNTIME_UNAVAILABLE'); });
    it('does not use a larger neighboring profile to relax a smaller resource budget',()=>{
      const {q,r}=protocolFixture();
      const budget={measurementHash:q.manifest.measurementHash,limits:{...q.plan.limits,memoryMiB:128},hash:''};budget.hash=hash({measurementHash:budget.measurementHash,limits:budget.limits});
      q.profiles.push({profileId:'VAL-B',budgetProfile:budget});
      q.plan.commands.push({...q.plan.commands[0]!,profileId:'VAL-B',budgetProfileHash:budget.hash});
      q.plan.limits.memoryMiB=128;q.plan.limits.totalTimeoutMs=2000;q.planHash=hash(q.plan);r.requestHash=hash(q);
      r.results.push({...r.results[0]!,profileId:'VAL-B'});r.results[0]!.measurements={...r.results[0]!.measurements,rssBytes:65*1048576};r.measurements={...r.measurements,wallMs:25,cpuMs:12,rssBytes:65*1048576};
      expect(validateBaselineReceipt(q,r).passed).toBe(false);
    });
    it('rejects mismatched budget measurement provenance and duplicated profiles',()=>{
      const {q,r}=protocolFixture();q.profiles[0]!.budgetProfile.measurementHash='e'.repeat(64);
      expect(()=>validateBaselineReceipt(q,r)).toThrow();
      const f=protocolFixture();f.q.profiles.push(f.q.profiles[0]!);expect(()=>validateBaselineRequest(f.q)).toThrow();
    });

    it.each([999,30001,120000])('rejects out-of-range command timeout %i before runner admission',timeoutMs=>{
        const {q}=protocolFixture();q.plan.commands[0]!.timeoutMs=timeoutMs;
        const reserved=Math.max(1000,timeoutMs);q.plan.limits.totalTimeoutMs=reserved;
        const b=q.profiles[0]!.budgetProfile;b.limits.totalTimeoutMs=reserved;b.hash=hash({measurementHash:b.measurementHash,limits:b.limits});q.plan.commands[0]!.budgetProfileHash=b.hash;
        q.planHash=hash(q.plan);expect(()=>validateBaselineRequest(q)).toThrow();
    });
    it.each([1000,30000])('accepts the shared command timeout boundary %i',timeoutMs=>{
        const {q}=protocolFixture();q.plan.commands[0]!.timeoutMs=timeoutMs;q.plan.limits.totalTimeoutMs=timeoutMs;
        q.profiles[0]!.budgetProfile.limits.totalTimeoutMs=timeoutMs;
        const b=q.profiles[0]!.budgetProfile;b.hash=hash({measurementHash:b.measurementHash,limits:b.limits});q.plan.commands[0]!.budgetProfileHash=b.hash;
        q.planHash=hash(q.plan);expect(()=>validateBaselineRequest(q)).not.toThrow();
    });

});
