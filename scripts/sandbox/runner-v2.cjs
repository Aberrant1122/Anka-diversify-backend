// Protocol-2 command primitive for a future reviewed image supervisor. This file
// is NOT a runnable admitted sandbox. CLI always fails closed. It reports raw
// observations only; cgroup/source-write/dependency/cleanup attestations must be
// measured outside the repository process and validated by baseline-protocol.ts.
// Protocol-2 uses the schema1-compatible per-command range 1000..30000ms.
const { spawn } = require('node:child_process');
function sourceCwd(p) { return p === '/source' || (typeof p === 'string' && p.startsWith('/source/') && !/[\\\x00:]/.test(p) && p.slice(8).split('/').every(s => s && s !== '.' && s !== '..')); }
function observeCommand(command, limits, spawnChild = spawn, killGroup = (pid) => process.kill(-pid, 'SIGKILL')) {
  if (!command || !/^\/opt\/anka\/bin\/[a-zA-Z0-9_-]+$/.test(command.executable) || !Array.isArray(command.argv) || command.argv.length > 31 || command.argv.some(a => typeof a !== 'string' || a.includes('\0')) || !sourceCwd(command.cwd) || !Number.isInteger(command.timeoutMs) || command.timeoutMs < 1000 || command.timeoutMs > 30000 || !limits || !Number.isSafeInteger(limits.stdoutBytes) || !Number.isSafeInteger(limits.stderrBytes) || limits.stdoutBytes < 1 || limits.stderrBytes < 1 || limits.stdoutBytes > 65536 || limits.stderrBytes > 65536) throw new Error('Invalid protocol-2 command');
  return new Promise(resolve => {
    const chunks = { stdout: [], stderr: [] }, counts = { stdout: 0, stderr: 0 };
    let timedOut = false, settled = false, timer, grace;
    const started = Date.now();
    let child;
    const stop = () => { try { if (child && Number.isInteger(child.pid)) killGroup(child.pid); } catch {} };
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace); stop();
      resolve({ exitCode, signal, timedOut,
        outputLimitCause: counts.stdout > limits.stdoutBytes ? (counts.stderr > limits.stderrBytes ? 'BOTH' : 'STDOUT') : counts.stderr > limits.stderrBytes ? 'STDERR' : null,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        observations: { wallMs: Math.max(0, Date.now()-started), stdoutBytes: counts.stdout, stderrBytes: counts.stderr },
        measurementEvidence: 'UNVERIFIED', cleanupConfirmed: false,
      });
    };
    try {
      child = spawnChild(command.executable, command.argv, {
        cwd: command.cwd, detached: true, shell: false, stdio: ['ignore','pipe','pipe'],
        env: { PATH:'/opt/anka/bin', HOME:'/tmp', TMPDIR:'/tmp', CI:'true', NODE_ENV:'test', PYTHONDONTWRITEBYTECODE:'1', PYTHONNOUSERSITE:'1', npm_config_offline:'true', npm_config_cache:'/scratch/npm', npm_config_audit:'false', npm_config_fund:'false' },
      });
    } catch { finish(null, null); return; }
    const add = (kind, chunk) => {
      const b=Buffer.from(chunk), before=counts[kind];counts[kind]+=b.length;
      const remaining=Math.max(0,limits[kind+'Bytes']-before);
      if(remaining)chunks[kind].push(b.subarray(0,remaining));
      if(counts[kind]>limits[kind+'Bytes']){stop();if(!grace)grace=setTimeout(()=>finish(null,'SIGKILL'),1000);}
    };
    child.stdout.on('data',b=>add('stdout',b));child.stderr.on('data',b=>add('stderr',b));
    timer=setTimeout(()=>{timedOut=true;stop();if(!grace)grace=setTimeout(()=>finish(null,'SIGKILL'),1000);},command.timeoutMs);
    child.once('error',()=>finish(null,null));child.once('close',(code,signal)=>finish(code,signal));
  });
}
module.exports={observeCommand};
if(require.main===module){process.stderr.write('BASELINE_RUNTIME_UNAVAILABLE: reviewed supervisor and runtime acceptance required\n');process.exitCode=1;}
