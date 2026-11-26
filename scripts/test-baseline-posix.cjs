// Linux-only source/protocol contract checks, not hardened runtime acceptance.
const {spawnSync}=require('node:child_process');
if(process.platform!=='linux'){
  process.stderr.write('POSIX_MODE_CHECKS_REQUIRE_LINUX: Windows chmod/stat is not POSIX permission evidence\n');
  process.exitCode=1;
}else{
  const env={PATH:process.env.PATH,HOME:process.env.HOME,TEMP:process.env.TEMP,TMP:process.env.TMP,NODE_ENV:'test',JWT_SECRET:'synthetic-workspace-test-key',ENCRYPTION_KEY:'00000000000000000000000000000000',DATABASE_URL:'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic?connect_timeout=1',ANKA_WORKSPACE_AI_ENABLED:'false',ANKA_REQUIRE_POSIX_MODE_CHECKS:'1'};
  const result=spawnSync(process.execPath,['--experimental-vm-modules','node_modules/jest/bin/jest.js','--config','jest.config.json','--runInBand','--runTestsByPath','src/workspace/__tests__/baseline-snapshot.test.ts','src/workspace/__tests__/baseline-protocol.test.ts','src/workspace/__tests__/baseline-runner.test.ts','--json','--outputFile=baseline-posix-results.json'],{stdio:'inherit',env});
  process.exitCode=result.status??1;
}
