import fs from 'fs';
import path from 'path';
import { hash, WorkspaceError } from './document-contract';
import { BaselineRequest2, Receipt2, CommandReceipt2, validateBaselineRequest, validateBaselineReceipt } from './baseline-protocol';
import { BaselineSnapshot, BaselineSnapshots } from './baseline-snapshot';
import type { BaselineValidationOperation } from '@prisma/client';
export function baselineRequestForOperation(op: BaselineValidationOperation, snapshot: BaselineSnapshot, manifest: BaselineRequest2['manifest']): BaselineRequest2 {
    const a = op.authority as any;
    if (op.purpose !== 'BASELINE_VALIDATION' || op.status !== 'PREPARING' || a.bindingHash !== hash(a.binding) || a.planHash !== hash(a.plan) || a.plan.commands.some((c: any) => c.repositoryId !== snapshot.repositoryId || c.baseline !== snapshot.commit))
        throw new WorkspaceError('BASELINE_BINDING_MISMATCH');
    const q: BaselineRequest2 = { protocol: 2, purpose: 'BASELINE_VALIDATION', nonce: op.id, operationId: op.id, jobId: op.jobId, bindingHash: a.bindingHash, planHash: a.planHash, plan: a.plan, profiles: a.binding.profiles.map((p:any)=>({profileId:p.id,budgetProfile:p.budgetProfile})), snapshot: { commit: snapshot.commit, tree: snapshot.tree, sourceHash: snapshot.sourceHash, snapshotHash: snapshot.snapshotHash, exclusionPolicyHash: snapshot.exclusionPolicyHash, sourceLocksHash: snapshot.sourceLocksHash }, manifest, runtimeProfileHash: hash(manifest) };
    validateBaselineRequest(q);
    return q;
}
export function baselineContainerSpec(q: BaselineRequest2, snapshot: BaselineSnapshot, reader: BaselineSnapshots, dependencyDirectory?: string) {
    validateBaselineRequest(q);
    if (q.snapshot.snapshotHash !== snapshot.snapshotHash)
        throw new WorkspaceError('BASELINE_BINDING_MISMATCH');
    reader.verify(snapshot);
    const local = (p: string) => { if (!path.isAbsolute(p) || /[,:\r\n]/.test(p.replace(/^[A-Za-z]:/, '')) || fs.lstatSync(p).isSymbolicLink() || !fs.statSync(p).isDirectory())
        throw new WorkspaceError('BASELINE_MOUNT_INVALID'); return fs.realpathSync(p); };
    const source = local(snapshot.directory), caps = q.plan.limits;
    const args = ['create', '--name', q.jobId, '--label', 'org.anka.request=' + hash(q), '--runtime', q.manifest.runtime, '--network', 'none', '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--cpus', '1', '--memory', caps.memoryMiB + 'm', '--memory-swap', caps.memoryMiB + 'm', '--ulimit', 'nofile=128:128', '--mount', 'type=bind,src=' + source + ',dst=/source,readonly', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=' + caps.tmpMiB + 'm', '--tmpfs', '/scratch:rw,noexec,nosuid,nodev,size=' + caps.workMiB + 'm', '--workdir', '/source', '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--env', 'CI=true', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'PYTHONNOUSERSITE=1', '--env', 'npm_config_offline=true', '--env', 'npm_config_cache=/scratch/npm', '--env', 'npm_config_audit=false', '--env', 'npm_config_fund=false', '--entrypoint', '/opt/anka/bin/node'];
    if (q.manifest.dependencyLayout === 'READONLY_SOURCE_NODE_MODULES') {
        if (!dependencyDirectory)
            throw new WorkspaceError('BASELINE_DEPENDENCIES_UNAVAILABLE');
        args.push('--mount', 'type=bind,src=' + local(dependencyDirectory) + ',dst=/source/node_modules,readonly');
    }
    else if (dependencyDirectory)
        throw new WorkspaceError('BASELINE_DEPENDENCIES_UNAVAILABLE');
    args.push('-i', q.manifest.imageDigest, '/opt/anka/runner-v2.cjs');
    return { args, request: JSON.stringify(q), requestHash: hash(q) };
}
// Contract orchestration only: an injected supervisor models the hardened image.
// It is never a production adapter, never falls back to host processes, and can
// only produce CONTRACT_TEST evidence. Actual cgroup/mount/cleanup attestations
// must come from a separately reviewed runtime supervisor outside the container.
export interface Protocol2ContractSupervisor {
    command(command: {
        executable: string;
        argv: string[];
        cwd: string;
        timeoutMs: number;
    }, index: number): Promise<CommandReceipt2>;
    finish(): Promise<Pick<Receipt2, 'measurements' | 'cleanup'>>;
}
export async function rehearseBaselineProtocol(q: BaselineRequest2, supervisor: Protocol2ContractSupervisor) {
    validateBaselineRequest(q);
    const results: CommandReceipt2[] = [];
    for (let i = 0; i < q.plan.commands.length; i++) {
        const c = q.plan.commands[i];
        results.push(await supervisor.command({ executable: q.manifest.executables[c.argv[0]]!, argv: c.argv.slice(1), cwd: c.cwd === '.' ? '/source' : '/source/' + c.cwd, timeoutMs: c.timeoutMs }, i));
    }
    const { measurements, cleanup } = await supervisor.finish();
    const receipt: Receipt2 = { protocol: 2, requestHash: hash(q), nonce: q.nonce, operationId: q.operationId, jobId: q.jobId, results, measurements, cleanup };
    return { receipt, ...validateBaselineReceipt(q, receipt) };
}
export class BaselineHardenedRunner {
    async ready() { return false; }
    async run(_request: BaselineRequest2): Promise<never> { throw new WorkspaceError('BASELINE_RUNTIME_UNAVAILABLE', 503); }
}
