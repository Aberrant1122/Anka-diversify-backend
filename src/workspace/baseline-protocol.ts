import { hash, WorkspaceError, parseCommands, ValidationBudget } from './document-contract';
import type { baselinePlan } from './baseline-validation-service';
export type BaselinePlan = Omit<ReturnType<typeof baselinePlan>, "limits"> & {
    limits: {
        totalTimeoutMs: number;
        memoryMiB: number;
        workMiB: number;
        tmpMiB: number;
        stdoutBytes: number;
        stderrBytes: number;
    };
};
export interface RuntimeManifest {
    protocol: 2;
    imageDigest: string;
    runtime: 'runsc' | 'kata-runtime';
    dependencyHash: string;
    sourceHash: string;
    sourceLocksHash: string;
    runnerHash: string;
    executables: Record<string, string>;
    dependencyLayout: 'NONE' | 'READONLY_SOURCE_NODE_MODULES';
    network: 'NONE';
    source: 'READONLY';
    measurementHash: string;
}
export interface BaselineRequest2 {
    protocol: 2;
    purpose: 'BASELINE_VALIDATION';
    nonce: string;
    operationId: string;
    jobId: string;
    bindingHash: string;
    planHash: string;
    plan: BaselinePlan;
    profiles: { profileId:string; budgetProfile:ValidationBudget }[];
    snapshot: {
        commit: string;
        tree: string;
        sourceHash: string;
        snapshotHash: string;
        exclusionPolicyHash: string;
        sourceLocksHash: string;
    };
    manifest: RuntimeManifest;
    runtimeProfileHash: string;
}
const fail = (): never => { throw new WorkspaceError('BASELINE_PROTOCOL_INVALID', 422); };
const exact = (v: any, keys: string[]) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.prototype.hasOwnProperty.call(v, k)))
    fail(); };
const sha = (v: any) => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))
    fail(); };
const integer = (v: any, max: number) => { if (!Number.isSafeInteger(v) || v < 0 || v > max)
    fail(); };
export function validateBaselineRequest(request: BaselineRequest2): void {
    const q = request;
    exact(q, ['protocol', 'purpose', 'nonce', 'operationId', 'jobId', 'bindingHash', 'planHash', 'plan', 'profiles', 'snapshot', 'manifest', 'runtimeProfileHash']);
    if (q.protocol !== 2 || q.purpose !== 'BASELINE_VALIDATION' || !/^[a-f0-9-]{36}$/.test(q.nonce) || !/^[a-f0-9-]{36}$/.test(q.operationId) || !/^[a-zA-Z0-9-]{8,150}$/.test(q.jobId))
        fail();
    [q.bindingHash, q.planHash, q.runtimeProfileHash].forEach(sha);
    exact(q.snapshot, ['commit', 'tree', 'sourceHash', 'snapshotHash', 'exclusionPolicyHash', 'sourceLocksHash']);
    if (!/^[a-f0-9]{40}$/.test(q.snapshot.commit) || !/^[a-f0-9]{40}$/.test(q.snapshot.tree))
        fail();
    [q.snapshot.sourceHash, q.snapshot.snapshotHash, q.snapshot.exclusionPolicyHash, q.snapshot.sourceLocksHash].forEach(sha);
    const m = q.manifest;
    exact(m, ['protocol', 'imageDigest', 'runtime', 'dependencyHash', 'sourceHash', 'sourceLocksHash', 'runnerHash', 'executables', 'dependencyLayout', 'network', 'source', 'measurementHash']);
    if (m.protocol !== 2 || !/^sha256:[a-f0-9]{64}$/.test(m.imageDigest) || !['runsc', 'kata-runtime'].includes(m.runtime) || m.network !== 'NONE' || m.source !== 'READONLY' || !['NONE', 'READONLY_SOURCE_NODE_MODULES'].includes(m.dependencyLayout))
        fail();
    [m.dependencyHash, m.sourceHash, m.sourceLocksHash, m.runnerHash, m.measurementHash].forEach(sha);
    if (m.sourceHash !== q.snapshot.sourceHash || m.sourceLocksHash !== q.snapshot.sourceLocksHash || hash(m) !== q.runtimeProfileHash)
        fail();
    if (!m.executables || typeof m.executables !== 'object' || Array.isArray(m.executables) || !Object.keys(m.executables).length || Object.entries(m.executables).some(([k, v]) => !/^(?:node|npm|pnpm|yarn|python3|pytest|go|cargo|dotnet)$/.test(k) || typeof v !== 'string' || !/^\/opt\/anka\/bin\/[a-zA-Z0-9_-]+$/.test(v)))
        fail();
    exact(q.plan, ['commands', 'limits', 'executionOrder']);
    const maxima = { totalTimeoutMs: 120000, memoryMiB: 512, workMiB: 256, tmpMiB: 64, stdoutBytes: 65536, stderrBytes: 65536 };
    exact(q.plan.limits, Object.keys(maxima));
    for (const [k, max] of Object.entries(maxima)) {
        const n = (q.plan.limits as any)[k];
        integer(n, max);
        if (n === 0)
            fail();
    }
    if (q.plan.executionOrder !== 'SEQUENTIAL_PROFILES' || hash(q.plan) !== q.planHash || !Array.isArray(q.plan.commands) || !q.plan.commands.length || q.plan.commands.length > 8)
        fail();
    if(!Array.isArray(q.profiles)||!q.profiles.length||q.profiles.length>8||new Set(q.profiles.map(p=>p.profileId)).size!==q.profiles.length)fail();
    for(const p of q.profiles){
      exact(p,['profileId','budgetProfile']);exact(p.budgetProfile,['hash','measurementHash','limits']);
      if(!/^VAL-[A-Z0-9-]+$/.test(p.profileId)||p.budgetProfile.measurementHash!==m.measurementHash||p.budgetProfile.hash!==hash({measurementHash:p.budgetProfile.measurementHash,limits:p.budgetProfile.limits}))fail();
      exact(p.budgetProfile.limits,Object.keys(maxima));
      for(const [k,max] of Object.entries(maxima)){const n=(p.budgetProfile.limits as any)[k];integer(n,max);if(!n)fail();}
      if(!q.plan.commands.some(c=>c.profileId===p.profileId)||q.plan.commands.filter(c=>c.profileId===p.profileId).reduce((n,c)=>n+c.timeoutMs,0)>p.budgetProfile.limits.totalTimeoutMs)fail();
    }
    for(const k of Object.keys(maxima)){
      const expected=k==='totalTimeoutMs'?q.profiles.reduce((n,p)=>n+p.budgetProfile.limits.totalTimeoutMs,0):Math.max(...q.profiles.map(p=>(p.budgetProfile.limits as any)[k]));
      if((q.plan.limits as any)[k]!==expected)fail();
    }
    const seen = new Set<string>();
    for (const c of q.plan.commands) {
        exact(c, ['profileId', 'repositoryId', 'baseline', 'runtimeProfileHash', 'budgetProfileHash', 'id', 'criterionId', 'argv', 'cwd', 'timeoutMs']);
        if (!/^VAL-[A-Z0-9-]+$/.test(c.profileId) || typeof c.repositoryId !== 'string' || !c.repositoryId || c.baseline !== q.snapshot.commit || c.runtimeProfileHash !== q.runtimeProfileHash)
            fail();
        sha(c.budgetProfileHash);
        if(q.profiles.find(p=>p.profileId===c.profileId)?.budgetProfile.hash!==c.budgetProfileHash)fail();
        parseCommands([{ id: c.id, criterionId: c.criterionId, argv: c.argv, cwd: c.cwd, timeoutMs: c.timeoutMs }], new Set([c.criterionId]));
        if (!/^AC-[A-Z0-9-]+$/.test(c.criterionId) || !m.executables[c.argv[0]] || c.cwd.includes('\\') || c.cwd.includes(':'))
            fail();
        const key = JSON.stringify([c.profileId, c.id]);
        if (seen.has(key))
            fail();
        seen.add(key);
    }
    if (q.plan.commands.reduce((n, c) => n + c.timeoutMs, 0) > q.plan.limits.totalTimeoutMs)
        fail();
}
export interface CommandReceipt2 {
    profileId: string;
    repositoryId: string;
    id: string;
    criterionId: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    outputLimitCause: 'STDOUT' | 'STDERR' | 'BOTH' | null;
    stdout: string;
    stderr: string;
    measurements: {
        wallMs: number;
        cpuMs: number;
        rssBytes: number;
        tmpBytes: number;
        workBytes: number;
        stdoutBytes: number;
        stderrBytes: number;
        oomKilled: boolean;
        sourceWriteAttempted: boolean;
    };
}
export interface Receipt2 {
    protocol: 2;
    requestHash: string;
    nonce: string;
    operationId: string;
    jobId: string;
    results: CommandReceipt2[];
    measurements: {
        wallMs: number;
        cpuMs: number;
        rssBytes: number;
        tmpBytes: number;
        workBytes: number;
        sourceUnchanged: boolean;
        dependencyUnchanged: boolean;
        descendantsRemaining: number;
    };
    cleanup: {
        jobId: string;
        nonce: string;
        confirmed: boolean;
        mountsReleased: boolean;
        descendantsRemaining: number;
    };
}
// Structural validation yields contract evidence only. Raw JSON never establishes runtime acceptance.
export function validateBaselineReceipt(q: BaselineRequest2, raw: unknown) {
    validateBaselineRequest(q);
    const r = raw as Receipt2;
    exact(r, ['protocol', 'requestHash', 'nonce', 'operationId', 'jobId', 'results', 'measurements', 'cleanup']);
    if (r.protocol !== 2 || r.requestHash !== hash(q) || r.nonce !== q.nonce || r.operationId !== q.operationId || r.jobId !== q.jobId || !Array.isArray(r.results) || r.results.length !== q.plan.commands.length)
        fail();
    const caps = q.plan.limits;
    let wall = 0, cpu = 0, failed = false;
    for (let i = 0; i < r.results.length; i++) {
        const v = r.results[i], c = q.plan.commands[i];
        exact(v, ['profileId', 'repositoryId', 'id', 'criterionId', 'exitCode', 'signal', 'timedOut', 'outputLimitCause', 'stdout', 'stderr', 'measurements']);
        if (v.profileId !== c.profileId || v.repositoryId !== c.repositoryId || v.id !== c.id || v.criterionId !== c.criterionId || !(v.exitCode === null || (Number.isInteger(v.exitCode) && v.exitCode >= 0 && v.exitCode <= 255)) || !(v.signal === null || ['SIGKILL', 'SIGTERM', 'SIGSEGV', 'SIGABRT', 'SIGINT', 'SIGPIPE', 'SIGXCPU', 'SIGXFSZ'].includes(v.signal)) || typeof v.timedOut !== 'boolean' || ![null, 'STDOUT', 'STDERR', 'BOTH'].includes(v.outputLimitCause) || typeof v.stdout !== 'string' || typeof v.stderr !== 'string')
            fail();
        const commandCaps=q.profiles.find(p=>p.profileId===c.profileId)!.budgetProfile.limits;
        const m = v.measurements;
        exact(m, ['wallMs', 'cpuMs', 'rssBytes', 'tmpBytes', 'workBytes', 'stdoutBytes', 'stderrBytes', 'oomKilled', 'sourceWriteAttempted']);
        for (const k of ['wallMs', 'cpuMs', 'rssBytes', 'tmpBytes', 'workBytes', 'stdoutBytes', 'stderrBytes'] as const)
            integer(m[k], Number.MAX_SAFE_INTEGER);
        if (typeof m.oomKilled !== 'boolean' || typeof m.sourceWriteAttempted !== 'boolean' || m.stdoutBytes < Buffer.byteLength(v.stdout) || m.stderrBytes < Buffer.byteLength(v.stderr) || Buffer.byteLength(v.stdout) > caps.stdoutBytes || Buffer.byteLength(v.stderr) > caps.stderrBytes)
            fail();
        const overflow = m.stdoutBytes > caps.stdoutBytes || m.stderrBytes > caps.stderrBytes;
        if (overflow && v.outputLimitCause === null)
            fail();
        if (v.outputLimitCause === null && (m.stdoutBytes !== Buffer.byteLength(v.stdout) || m.stderrBytes !== Buffer.byteLength(v.stderr)))
            fail();
        wall += m.wallMs;
        cpu += m.cpuMs;
        failed ||= v.exitCode !== 0 || v.signal !== null || v.timedOut || v.outputLimitCause !== null || m.oomKilled || m.sourceWriteAttempted || m.wallMs > c.timeoutMs || m.cpuMs > c.timeoutMs || m.rssBytes > commandCaps.memoryMiB * 1048576 || m.tmpBytes > commandCaps.tmpMiB * 1048576 || m.workBytes > commandCaps.workMiB * 1048576;
    }
    for(const p of q.profiles){const values=r.results.filter(v=>v.profileId===p.profileId),limits=p.budgetProfile.limits;
      failed ||= values.reduce((n,v)=>n+v.measurements.wallMs,0)>limits.totalTimeoutMs||values.reduce((n,v)=>n+v.measurements.cpuMs,0)>limits.totalTimeoutMs||values.reduce((n,v)=>n+v.measurements.stdoutBytes,0)>limits.stdoutBytes||values.reduce((n,v)=>n+v.measurements.stderrBytes,0)>limits.stderrBytes;
    }
    failed ||= r.results.reduce((n,v)=>n+v.measurements.stdoutBytes,0)>caps.stdoutBytes||r.results.reduce((n,v)=>n+v.measurements.stderrBytes,0)>caps.stderrBytes;
    const m = r.measurements;
    exact(m, ['wallMs', 'cpuMs', 'rssBytes', 'tmpBytes', 'workBytes', 'sourceUnchanged', 'dependencyUnchanged', 'descendantsRemaining']);
    for (const k of ['wallMs', 'cpuMs', 'rssBytes', 'tmpBytes', 'workBytes', 'descendantsRemaining'] as const)
        integer(m[k], Number.MAX_SAFE_INTEGER);
    if (typeof m.sourceUnchanged !== 'boolean' || typeof m.dependencyUnchanged !== 'boolean' || m.wallMs < wall || m.cpuMs < cpu || r.results.some(v => v.measurements.rssBytes > m.rssBytes || v.measurements.tmpBytes > m.tmpBytes || v.measurements.workBytes > m.workBytes))
        fail();
    const cl = r.cleanup;
    exact(cl, ['jobId', 'nonce', 'confirmed', 'mountsReleased', 'descendantsRemaining']);
    integer(cl.descendantsRemaining, Number.MAX_SAFE_INTEGER);
    if (cl.jobId !== q.jobId || cl.nonce !== q.nonce || typeof cl.confirmed !== 'boolean' || typeof cl.mountsReleased !== 'boolean')
        fail();
    const cleanupConfirmed = cl.confirmed && cl.mountsReleased && cl.descendantsRemaining === 0 && m.descendantsRemaining === 0;
    const passed = !failed && m.sourceUnchanged && m.dependencyUnchanged && m.wallMs <= caps.totalTimeoutMs && m.cpuMs <= caps.totalTimeoutMs && m.rssBytes <= caps.memoryMiB * 1048576 && m.tmpBytes <= caps.tmpMiB * 1048576 && m.workBytes <= caps.workMiB * 1048576 && cleanupConfirmed;
    return { evidenceClass: 'CONTRACT_TEST' as const, passed, cleanupConfirmed, requestHash: hash(q), receiptHash: hash(r) };
}
export interface RuntimeEvidenceRecord {
    runtimeProfileHash: string;
    measurementHash: string;
    dependencyHash: string;
    sourceHash: string;
    sourceLocksHash: string;
    imageDigest: string;
    runnerHash: string;
    runtime: 'runsc' | 'kata-runtime';
    budgetProfileHashes: string[];
    runtimeAcceptanceRecordId: string;
    measurementAcceptanceRecordId: string;
}
// A future server-owned attestation verifier must validate signed, durable records.
// No implementation, environment switch, or HTTP registration is supplied by V3.
export interface TrustedRuntimeProvenance {
    lookup(runtimeProfileHash: string): Promise<RuntimeEvidenceRecord | null>;
    verify(kind: 'RUNTIME_ACCEPTANCE' | 'MEASURED_BUDGET' | 'JOB_EXECUTION' | 'JOB_CLEANUP', recordId: string, expectedHash: string): Promise<boolean>;
}
export async function verifyBaselineRuntimeEvidence(q: BaselineRequest2, r: Receipt2, ids: {
    execution: string;
    cleanup: string;
}, store: TrustedRuntimeProvenance) {
    const result = validateBaselineReceipt(q, r), record = await store.lookup(q.runtimeProfileHash);
    if (!record || record.runtimeProfileHash !== q.runtimeProfileHash || record.measurementHash !== q.manifest.measurementHash || record.dependencyHash !== q.manifest.dependencyHash || record.sourceHash !== q.snapshot.sourceHash || record.sourceLocksHash !== q.snapshot.sourceLocksHash || record.imageDigest !== q.manifest.imageDigest || record.runnerHash !== q.manifest.runnerHash || record.runtime !== q.manifest.runtime || hash([...record.budgetProfileHashes].sort()) !== hash([...new Set(q.plan.commands.map(c => c.budgetProfileHash))].sort()))
        throw new WorkspaceError('BASELINE_RUNTIME_UNAVAILABLE', 503);
    const acceptanceHash = hash({ manifest: q.manifest, runtimeProfileHash: q.runtimeProfileHash });
    const budgetHash = hash({ measurementHash: record.measurementHash, budgetProfileHashes: record.budgetProfileHashes, planHash: q.planHash, limits: q.plan.limits });
    if (!ids.execution || !ids.cleanup || !record.runtimeAcceptanceRecordId || !record.measurementAcceptanceRecordId || !await store.verify('RUNTIME_ACCEPTANCE', record.runtimeAcceptanceRecordId, acceptanceHash) || !await store.verify('MEASURED_BUDGET', record.measurementAcceptanceRecordId, budgetHash) || !await store.verify('JOB_EXECUTION', ids.execution, hash({ requestHash: hash(q), receiptHash: hash(r) })) || !await store.verify('JOB_CLEANUP', ids.cleanup, hash({ requestHash: hash(q), cleanup: r.cleanup })))
        throw new WorkspaceError('TRUSTED_BASELINE_EVIDENCE_REQUIRED', 503);
    return { ...result, evidenceClass: 'DYNAMIC_ISOLATED_COMMAND_CHECKS' as const };
}
