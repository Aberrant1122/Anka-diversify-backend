import { EventEmitter } from 'events';
const { observeCommand } = require('../../../scripts/sandbox/runner-v2.cjs');
describe('protocol2 runner raw command primitive (injected processes only)', () => {
    const command = { executable: '/opt/anka/bin/node', argv: ['--test', 'test.cjs'], cwd: '/source', timeoutMs: 1000 }, limits = { stdoutBytes: 4, stderrBytes: 4 };
    const child = () => Object.assign(new EventEmitter(), { pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter() });
    it('uses fixed executables, isolated env, no shell and never claims measured cleanup', async () => { const c = child(), kill = jest.fn(), spawn = jest.fn(() => c); const pending = observeCommand(command, limits, spawn, kill); const options = spawn.mock.calls[0] as any; expect(options[2].shell).toBe(false); expect(options[2].env.NODE_PATH).toBeUndefined(); expect(options[2].env.OPENAI_API_KEY).toBeUndefined(); c.stdout.emit('data', Buffer.from('ok')); c.emit('close', 0, null); expect(await pending).toMatchObject({ exitCode: 0, signal: null, stdout: 'ok', measurementEvidence: 'UNVERIFIED', cleanupConfirmed: false }); expect(kill).toHaveBeenCalledWith(123); });
    it('counts bytes, bounds retained output and preserves signal/overflow even exit zero', async () => { const c = child(), kill = jest.fn(); const pending = observeCommand(command, limits, () => c, kill); c.stdout.emit('data', Buffer.from('abcdef')); c.emit('close', 0, 'SIGKILL'); expect(await pending).toMatchObject({ exitCode: 0, signal: 'SIGKILL', stdout: 'abcd', outputLimitCause: 'STDOUT', observations: { stdoutBytes: 6 } }); expect(kill).toHaveBeenCalled(); });
    it('records timeout and kills the process group without inventing an exit code', async () => { jest.useFakeTimers(); try {
        const c = child(), kill = jest.fn(), pending = observeCommand(command, limits, () => c, kill);
        jest.advanceTimersByTime(1001);
        c.emit('close', null, 'SIGKILL');
        expect(await pending).toMatchObject({ timedOut: true, exitCode: null, signal: 'SIGKILL' });
        expect(kill).toHaveBeenCalledWith(123);
    }
    finally {
        jest.useRealTimers();
    } });
    it('rejects shell paths, writable cwd and unbounded streams before spawning', () => { for (const bad of [{ ...command, executable: '/bin/sh' }, { ...command, cwd: '/tmp' }, { ...command, cwd: '/source/../tmp' }])
        expect(() => observeCommand(bad, limits, jest.fn())).toThrow(); expect(() => observeCommand(command, { ...limits, stdoutBytes: 65537 }, jest.fn())).toThrow(); });
});
