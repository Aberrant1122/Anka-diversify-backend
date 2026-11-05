import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { hash, WorkspaceError } from './document-contract';
export const baselineExclusions = Object.freeze({ version: 1, segments: ['.git', 'node_modules'], secretPattern: /(^|\/)(?:\.env[^/]*|\.npmrc|\.pypirc|\.netrc|\.git|node_modules|id_(?:rsa|ed25519)|[^/]*\.(?:pem|key))(?:\/|$)/i.source });
const excluded = (name: string) => new RegExp(baselineExclusions.secretPattern, 'i').test(name);
export function baselinePath(name: string) {
    if (!name || name.length > 1024 || name !== name.normalize('NFC') || /[\\\x00-\x1f\x7f:]/.test(name) || name.startsWith('/') || name.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)))
        throw new WorkspaceError('BASELINE_PATH_REJECTED');
}
export interface BaselineSourcePolicy {
    repositories: ReadonlyMap<string, string>;
    snapshotsRoot: string;
    maxFiles?: number;
    maxBytes?: number;
}
export interface BaselineSnapshot {
    directory: string;
    repositoryId: string;
    commit: string;
    tree: string;
    files: {
        path: string;
        mode: string;
        bytes: number;
        sha256: string;
    }[];
    excluded: {
        path: string;
        object: string;
        bytes: number;
    }[];
    exclusionPolicyHash: string;
    sourceHash: string;
    sourceLocksHash: string;
    snapshotHash: string;
}
const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function noLinks(target: string) {
    const absolute = path.resolve(target), parsed = path.parse(absolute);
    let current = parsed.root;
    for (const s of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, s);
        if (fs.lstatSync(current).isSymbolicLink())
            throw new WorkspaceError('BASELINE_SYMLINK_REJECTED');
    }
}
export class BaselineSnapshots {
    constructor(private policy: BaselineSourcePolicy) { }
    async create(repositoryId: string, commit: string): Promise<BaselineSnapshot> {
        if (!/^[a-f0-9]{40}$/.test(commit))
            throw new WorkspaceError('BASELINE_COMMIT_INVALID');
        const registered = this.policy.repositories.get(repositoryId);
        if (!registered)
            throw new WorkspaceError('REPOSITORY_SCOPE_MISMATCH');
        noLinks(registered);
        noLinks(this.policy.snapshotsRoot);
        const root = fs.realpathSync(registered), gitDir = path.join(root, '.git');
        noLinks(gitDir);
        if (!fs.statSync(gitDir).isDirectory())
            throw new WorkspaceError('BASELINE_REPOSITORY_INVALID');
        const identity = () => { noLinks(registered); noLinks(gitDir); const s = fs.statSync(gitDir); return hash([fs.realpathSync(registered), fs.realpathSync(gitDir), s.dev, s.ino, digest(fs.readFileSync(path.join(gitDir, 'config')))]); };
        const originalIdentity = identity();
        if (/^\s*\[(?:filter|include|includeIf)\b/im.test(fs.readFileSync(path.join(gitDir, 'config'), 'utf8')))
            throw new WorkspaceError('EXECUTABLE_GIT_CONFIG_REJECTED');
        // Read immutable objects; never checkout/clone, run filters, hooks, or read worktree source.
        const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=' + path.join(this.policy.snapshotsRoot, 'disabled-hooks'), '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'safe.directory=' + root, ...args], { cwd: root, timeout: 15000, maxBuffer: 21 * 1024 * 1024, windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } });
        const resolved = git('rev-parse', '--verify', commit + '^{commit}').toString().trim();
        if (resolved !== commit)
            throw new WorkspaceError('BASELINE_COMMIT_INVALID');
        const tree = git('rev-parse', commit + '^{tree}').toString().trim();
        const verifyObject = (type: string, id: string) => { const b = git('cat-file', type, id); if (createHash('sha1').update(Buffer.from(type + ' ' + b.length + '\0')).update(b).digest('hex') !== id)
            throw new WorkspaceError('BASELINE_PREIMAGE_CHANGED'); };
        verifyObject('commit', commit);
        verifyObject('tree', tree);
        const trees = git('ls-tree', '-r', '-t', '-z', commit).toString('utf8').split('\0').filter(Boolean);
        if (trees.length > 20000)
            throw new WorkspaceError('SANDBOX_INPUT_TOO_LARGE');
        for (const entry of trees) {
            const m = /^040000 tree ([a-f0-9]{40})\t/.exec(entry);
            if (m)
                verifyObject('tree', m[1]!);
        }
        const raw = git('ls-tree', '-r', '-z', '-l', commit);
        const decoded = raw.toString('utf8');
        if (!Buffer.from(decoded).equals(raw))
            throw new WorkspaceError('BASELINE_PATH_REJECTED');
        const rows = decoded.split('\0').filter(Boolean).map(row => {
            const m = /^(\d{6}) (\w+) ([a-f0-9]{40}) +([0-9]+|-)\t([\s\S]+)$/.exec(row);
            if (!m || m[2] !== 'blob' || !['100644', '100755'].includes(m[1]))
                throw new WorkspaceError('BASELINE_OBJECT_REJECTED');
            baselinePath(m[5]);
            return { path: m[5], mode: m[1], object: m[3], bytes: Number(m[4]) };
        }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        // Count the entire tree before materialization, including excluded entries.
        if (rows.length > Math.min(this.policy.maxFiles ?? 10000, 10000) || rows.reduce((n, r) => n + r.bytes, 0) > Math.min(this.policy.maxBytes ?? 20 * 1024 * 1024, 20 * 1024 * 1024))
            throw new WorkspaceError('SANDBOX_INPUT_TOO_LARGE');
        const prefixes = new Map<string, string>();
        for (const r of rows) {
            const parts = r.path.split('/');
            for (let i = 1; i <= parts.length; i++) {
                const p = parts.slice(0, i).join('/'), key = p.toLowerCase();
                if (prefixes.has(key) && prefixes.get(key) !== p)
                    throw new WorkspaceError('BASELINE_CASE_COLLISION');
                prefixes.set(key, p);
            }
        }
        const directory = path.join(fs.realpathSync(this.policy.snapshotsRoot), randomUUID());
        fs.mkdirSync(directory, { mode: 0o755 });
        const files: BaselineSnapshot['files'] = [], omissions: BaselineSnapshot['excluded'] = [];
        try {
            for (const r of rows) {
                if (excluded(r.path)) {
                    omissions.push({ path: r.path, object: r.object, bytes: r.bytes });
                    continue;
                }
                const content = git('cat-file', 'blob', r.object);
                if (content.length !== r.bytes || createHash('sha1').update(Buffer.from('blob ' + content.length + '\0')).update(content).digest('hex') !== r.object)
                    throw new WorkspaceError('BASELINE_PREIMAGE_CHANGED');
                const target = path.join(directory, ...r.path.split('/'));
                fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
                fs.writeFileSync(target, content, { flag: 'wx', mode: r.mode === '100755' ? 0o555 : 0o444 });
                fs.chmodSync(target, r.mode === '100755' ? 0o555 : 0o444);
            files.push({ path: r.path, mode: r.mode, bytes: r.bytes, sha256: digest(content) });
            }
            const metadata = { repositoryId, commit, tree, files, excluded: omissions, exclusionPolicyHash: hash(baselineExclusions), sourceHash: hash(files), sourceLocksHash: hash(files.filter(f => /(^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|deno\.(?:jsonc?|lock)|(?:pnpm-lock|yarn)\.(?:yaml|lock)|pyproject\.toml|requirements[^/]*\.txt)$/.test(f.path))) };
            if (identity() !== originalIdentity || git('rev-parse', commit + '^{tree}').toString().trim() !== tree)
                throw new WorkspaceError('BASELINE_REPOSITORY_CHANGED');
            const snapshot = { ...metadata, directory, snapshotHash: hash(metadata) };
            const readable=(d:string)=>{fs.chmodSync(d,0o755);for(const e of fs.readdirSync(d,{withFileTypes:true}))if(e.isDirectory())readable(path.join(d,e.name));};
            readable(directory);
            this.verify(snapshot);
            return snapshot;
        }
        catch (e) {
            fs.rmSync(directory, { recursive: true, force: true });
            throw e;
        }
    }
    verify(s: BaselineSnapshot) {
        noLinks(this.policy.snapshotsRoot);
        noLinks(s.directory);
        if (path.dirname(fs.realpathSync(s.directory)) !== fs.realpathSync(this.policy.snapshotsRoot))
            throw new WorkspaceError('BASELINE_SNAPSHOT_SCOPE');
        const seen: string[] = [];
        const walk = (root: string, relative = '') => { for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            const name = relative ? relative + '/' + entry.name : entry.name;
            baselinePath(name);
            const file = path.join(root, entry.name);
            const stat = fs.lstatSync(file);
            if (stat.isSymbolicLink())
                throw new WorkspaceError('BASELINE_SYMLINK_REJECTED');
            if (stat.isDirectory()) {
                if (!s.files.some(f => f.path.startsWith(name + '/')))
                    throw new WorkspaceError('BASELINE_SOURCE_CHANGED');
                walk(file, name);
            }
            else if (stat.isFile()) {
                const expected = s.files.find(f => f.path === name);
                if (!expected || stat.size !== expected.bytes || digest(fs.readFileSync(file)) !== expected.sha256)
                    throw new WorkspaceError('BASELINE_SOURCE_CHANGED');
                seen.push(name);
            }
            else
                throw new WorkspaceError('BASELINE_SOURCE_CHANGED');
        } };
        walk(s.directory);
        const { directory: _, snapshotHash, ...metadata } = s;
        if (seen.length !== s.files.length || hash(metadata) !== snapshotHash || hash(s.files) !== s.sourceHash || s.exclusionPolicyHash !== hash(baselineExclusions))
            throw new WorkspaceError('BASELINE_SOURCE_CHANGED');
    }
}
