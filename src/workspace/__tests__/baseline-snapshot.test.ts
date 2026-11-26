import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { BaselineSnapshots, baselinePath, assertBaselinePosixMode } from '../baseline-snapshot';
import { baselineContainerSpec } from '../baseline-hardened-runner';
import { hash } from '../document-contract';
import { protocolFixture } from './baseline-protocol-fixture';
describe('immutable baseline snapshots from exact Git objects', () => {
    let root: string, repo: string, output: string, reader: BaselineSnapshots;
    const git = (...args: string[]) => execFileSync('git', ['-c', 'safe.directory=' + repo, '-c', 'core.hooksPath=' + output, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'test@example.invalid' } }).trim();
    const blob = (s: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: s, encoding: 'utf8' }).trim();
    const commit = (entries: {
        name: string;
        content: string;
        mode?: string;
    }[]) => { for (const e of entries)
        git('update-index', '--add', '--cacheinfo', e.mode ?? '100644', blob(e.content), e.name); const tree = git('write-tree'); return git('commit-tree', tree, '-m', 'Synthetic baseline'); };
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'anka-baseline-snapshot-')); repo = path.join(root, 'repo'); output = path.join(root, 'snapshots'); fs.mkdirSync(repo); fs.mkdirSync(output); git('init'); reader = new BaselineSnapshots({ repositories: new Map([['repo', repo]]), snapshotsRoot: output }); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    it('uses exact object source despite dirty/untracked worktree and records exclusions separately', async () => { const head = commit([{ name: 'src/main.cjs', content: 'safe' }, { name: '.env', content: 'secret' }, { name: 'node_modules/pkg/a.js', content: 'dependency' }, { name: 'package-lock.json', content: '{}' }]); fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src/main.cjs'), 'untrusted worktree'); fs.writeFileSync(path.join(repo, 'untracked'), 'not included'); const s = await reader.create('repo', head); expect(fs.readFileSync(path.join(s.directory, 'src/main.cjs'), 'utf8')).toBe('safe'); expect(s.excluded.map(f => f.path)).toEqual(['.env', 'node_modules/pkg/a.js']); expect(s.files.map(f => f.path)).toEqual(['package-lock.json', 'src/main.cjs']); expect(s.tree).toBe(git('rev-parse', head + '^{tree}')); expect(s.sourceLocksHash).toMatch(/^[a-f0-9]{64}$/); reader.verify(s); });
    it('rejects symlink and submodule Git tree entries before materialization', async () => { for (const mode of ['120000', '160000']) {
        git('read-tree', '--empty');
        const head = mode === '120000' ? commit([{ name: 'link', mode, content: '../../outside' }]) : (() => { const oid = commit([{ name: 'file', content: 'a' }]); git('update-index', '--add', '--cacheinfo', mode, oid, 'module'); return git('commit-tree', git('write-tree'), '-m', 'gitlink'); })();
        await expect(reader.create('repo', head)).rejects.toThrow('BASELINE_OBJECT_REJECTED');
        expect(fs.readdirSync(output)).toEqual([]);
    } });
    it('rejects case-colliding files and directories, including excluded names', async () => { const head = commit([{ name: 'SRC/a', content: 'a' }, { name: 'src/b', content: 'b' }]); await expect(reader.create('repo', head)).rejects.toThrow('BASELINE_CASE_COLLISION'); });
    it.each(['../x', 'a/../x', 'a\\b', '/absolute', 'a:stream', 'a//b', 'a/.', 'NUL.txt', 'a./b', 'a/b ', 'e\u0301.txt'])('rejects cross-platform path escape %s', name => expect(() => baselinePath(name)).toThrow('BASELINE_PATH_REJECTED'));
    it('enforces byte and file quotas before reading blobs, including excluded secrets', async () => { const head = commit([{ name: '.env', content: 'x'.repeat(128) }, { name: 'file', content: 'a' }]); const limited = new BaselineSnapshots({ repositories: new Map([['repo', repo]]), snapshotsRoot: output, maxBytes: 100, maxFiles: 10 }); await expect(limited.create('repo', head)).rejects.toThrow('SANDBOX_INPUT_TOO_LARGE'); expect(fs.readdirSync(output)).toEqual([]); });
    it.each(['modified', 'extra', 'missing', 'emptyDirectory', 'metadata'])('detects source postimage drift %s', async (kind) => { const s = await reader.create('repo', commit([{ name: 'file', content: 'a' }])); if (kind === 'modified') {
        fs.chmodSync(path.join(s.directory, 'file'), 0o600);
        fs.writeFileSync(path.join(s.directory, 'file'), 'b');
        fs.chmodSync(path.join(s.directory, 'file'), 0o444);
    } if (kind === 'extra')
        fs.writeFileSync(path.join(s.directory, 'extra'), 'b'); if (kind === 'missing')
        fs.unlinkSync(path.join(s.directory, 'file')); if (kind === 'emptyDirectory')
        fs.mkdirSync(path.join(s.directory, 'extra')); if (kind === 'metadata')
        s.commit = 'b'.repeat(40); expect(() => reader.verify(s)).toThrow('BASELINE_SOURCE_CHANGED'); });
    it('rejects unknown registration, symbolic refs and executable repository config', async () => { await expect(reader.create('unregistered', 'a'.repeat(40))).rejects.toThrow('REPOSITORY_SCOPE_MISMATCH'); await expect(reader.create('repo', 'HEAD')).rejects.toThrow('BASELINE_COMMIT_INVALID'); const head = commit([{ name: 'file', content: 'a' }]); fs.appendFileSync(path.join(repo, '.git/config'), '\n[include]\n path=missing\n'); await expect(reader.create('repo', head)).rejects.toThrow('EXECUTABLE_GIT_CONFIG_REJECTED'); });
    it('prepares read-only source, bounded scratch and hardened resource controls without launching', async () => { const s = await reader.create('repo', commit([{ name: 'file', content: 'a' }])); const { q } = protocolFixture(); q.snapshot = { commit: s.commit, tree: s.tree, sourceHash: s.sourceHash, snapshotHash: s.snapshotHash, exclusionPolicyHash: s.exclusionPolicyHash, sourceLocksHash: s.sourceLocksHash }; q.manifest.sourceHash = s.sourceHash; q.manifest.sourceLocksHash = s.sourceLocksHash; q.runtimeProfileHash = hash(q.manifest); q.plan.commands[0]!.baseline = s.commit; q.plan.commands[0]!.runtimeProfileHash = q.runtimeProfileHash; q.planHash = hash(q.plan); const spec = baselineContainerSpec(q, s, reader); expect(spec.args.join(' ')).toContain('dst=/source,readonly'); expect(spec.args).toContain('--read-only'); expect(spec.args).toContain('no-new-privileges:true'); expect(spec.args).toContain('none'); expect(spec.args.join(' ')).not.toContain('NODE_PATH'); expect(spec.args.join(' ')).not.toContain('/work/repository'); expect(spec.args).not.toContain('--privileged'); expect(spec.args.join(' ')).toContain('/scratch:rw,noexec,nosuid,nodev,size=32m'); });
    it('rejects symlinked registered roots and symlink postimages', async () => {
        const head = commit([{ name: 'file', content: 'safe' }]), alias = path.join(root, 'alias');
        fs.symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
        await expect(new BaselineSnapshots({ repositories: new Map([['repo', alias]]), snapshotsRoot: output }).create('repo', head)).rejects.toThrow('BASELINE_SYMLINK_REJECTED');
        const snapshot = await reader.create('repo', head);
        fs.symlinkSync(repo, path.join(snapshot.directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
        expect(() => reader.verify(snapshot)).toThrow('BASELINE_SYMLINK_REJECTED');
    });
    it('rejects a corrupt blob preimage even when its object filename and tree entry remain unchanged',async()=>{
      const head=commit([{name:'file',content:'a'}]),oid=git('rev-parse',head+':file');
      const object=path.join(repo,'.git','objects',oid.slice(0,2),oid.slice(2));
      fs.chmodSync(object,0o600);
      fs.writeFileSync(object,require('zlib').deflateSync(Buffer.from('blob 1\0b')));
      await expect(reader.create('repo',head)).rejects.toThrow('BASELINE_PREIMAGE_CHANGED');
      expect(fs.readdirSync(output)).toEqual([]);
    });

    it('compares all POSIX permission and special bits without pretending host chmod evidence',()=>{
        expect(()=>assertBaselinePosixMode(0o100444,0o444)).not.toThrow();
        expect(()=>assertBaselinePosixMode(0o100555,0o555)).not.toThrow();
        for(const mode of [0o400,0o644,0o555,0o744,0o2444,0o4444,0o1444])expect(()=>assertBaselinePosixMode(0o100000|mode,0o444)).toThrow('BASELINE_SOURCE_MODE_CHANGED');
    });
    it('labels Windows mode verification limitations explicitly',async()=>{
        const snapshot=await reader.create('repo',commit([{name:'file',content:'same'}]));
        expect(reader.verify(snapshot).permissionVerification).toBe(process.platform==='win32'?'WINDOWS_MODE_NOT_VERIFIABLE':'POSIX_MODE_VERIFIED');
        if(process.env.ANKA_REQUIRE_POSIX_MODE_CHECKS==='1')expect(process.platform).not.toBe('win32');
    });
    const posixIt=process.platform==='win32'?it.skip:it;
    posixIt.each([
        ['100644',0o000],['100644',0o400],['100644',0o644],['100644',0o555],['100644',0o1444],['100644',0o2444],['100644',0o4444],
        ['100755',0o444],['100755',0o755],['100755',0o1555],['100755',0o2555],['100755',0o4555],
    ] as const)('rejects native POSIX chmod tampering for Git mode %s -> %i without byte changes',async(mode,tampered)=>{
        const snapshot=await reader.create('repo',commit([{name:'file',content:'same',mode}])),file=path.join(snapshot.directory,'file');
        expect(fs.lstatSync(file).mode&0o7777).toBe(mode==='100755'?0o555:0o444);
        try{
            fs.chmodSync(file,tampered);
            expect(fs.lstatSync(file).mode&0o7777).toBe(tampered);
            expect(fs.lstatSync(file).size).toBe(4);
            expect(()=>reader.verify(snapshot)).toThrow('BASELINE_SOURCE_MODE_CHANGED');
        }finally{fs.chmodSync(file,mode==='100755'?0o555:0o444);}
        expect(fs.readFileSync(file,'utf8')).toBe('same');
    });
    posixIt.each(['root','nested'] as const)('rejects POSIX directory mode/special-bit drift: %s',async(kind)=>{
        const snapshot=await reader.create('repo',commit([{name:'nested/file',content:'same'}])),dir=kind==='root'?snapshot.directory:path.join(snapshot.directory,'nested');
        try{fs.chmodSync(dir,0o1777);expect(fs.lstatSync(dir).mode&0o7777).toBe(0o1777);expect(()=>reader.verify(snapshot)).toThrow('BASELINE_SOURCE_MODE_CHANGED');}
        finally{fs.chmodSync(dir,0o755);}
    });

});
