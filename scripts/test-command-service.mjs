import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { buildWindowsRunner } from './build-windows-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'out', 'main', 'command-service-test.cjs');
await build({ stdin: { contents: "export { Workspace } from './src/main/service'; export { Store } from './src/main/store'; export { selectedEnvironment } from './src/main/command-environment';", resolveDir: root, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['zod', 'original-fs'] });
if (process.platform === 'win32') await buildWindowsRunner();
const { Workspace, Store, selectedEnvironment } = createRequire(import.meta.url)(bundle);
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wwg-command-service-')));
const data = path.join(base, 'private'), source = path.join(base, 'source');
await fs.mkdir(data); await fs.mkdir(source);
await fs.writeFile(path.join(source, '.env'), 'NEVER_RETURN_THIS_PRIVATE_VALUE');
const store = new Store(path.join(data, 'workspace.json')); await store.load();
const workspace = new Workspace(store, data); await workspace.addFolders([source]);
const projectId = store.data.folders[0].id;
const windows = process.platform === 'win32';
const propose = command => workspace.propose({ requestId: randomUUID(), projectId, kind: 'command', path: '', command });
async function settled(job) { await workspace.waitForIdle(); return workspace.job(job.id); }
try {
  let job = await propose(windows ? "[IO.File]::WriteAllText('manual.txt','manual-ok')" : "printf 'manual-ok' > manual.txt");
  assert.equal(job.state, 'pending');
  await assert.rejects(fs.stat(path.join(source, 'manual.txt')), { code: 'ENOENT' });
  await workspace.decide(job.id, true); job = await settled(job);
  assert.equal(job.state, 'done', job.output);
  assert.match(await fs.readFile(path.join(source, 'manual.txt'), 'utf8'), /manual-ok/);
  console.log('PASS manual approval executes only after acceptance');

  await workspace.enableAutomatic(false, structuredClone(store.data.folders));
  job = await settled(await propose(windows ? 'New-Item -ItemType Directory bulk | Out-Null; Move-Item manual.txt bulk\\moved.txt; Remove-Item bulk -Recurse -Force' : 'mkdir bulk && mv manual.txt bulk/moved.txt && rm bulk/moved.txt && rmdir bulk'));
  assert.equal(job.state, 'done', job.output);
  await assert.rejects(fs.stat(path.join(source, 'manual.txt')), { code: 'ENOENT' });
  console.log('PASS automatic bulk operations');

  process.env.WWG_TEST_ALLOWED = 'secret-selected-value'; process.env.WWG_TEST_UNREQUESTED = 'must-not-inherit';
  await workspace.setEnvironmentNames(['WWG_TEST_ALLOWED']);
  if (windows) assert.equal(selectedEnvironment(['wwg_test_allowed'], ['WWG_TEST_ALLOWED']).WWG_TEST_ALLOWED, 'secret-selected-value');
  job = await workspace.propose({ requestId: randomUUID(), projectId, kind: 'command', path: '', command: windows ? 'Write-Output $env:WWG_TEST_ALLOWED; if($env:WWG_TEST_UNREQUESTED){exit 9}' : 'printf "%s" "$WWG_TEST_ALLOWED"; test -z "$WWG_TEST_UNREQUESTED"', environment: ['WWG_TEST_ALLOWED'] });
  job = await settled(job); assert.equal(job.state, 'done', job.output);
  assert.ok(!job.output.includes('secret-selected-value')); assert.ok(job.output.includes('[환경변수 값 숨김]'));
  delete process.env.WWG_TEST_ALLOWED; delete process.env.WWG_TEST_UNREQUESTED;
  console.log('PASS selected OS environment only and streaming output redaction');

  job = await settled(await propose(windows ? 'Get-Content .env' : 'cat .env'));
  assert.equal(job.state, 'failed', job.output);
  assert.ok(!job.output.includes('NEVER_RETURN_THIS_PRIVATE_VALUE'));
  console.log('PASS original .env cannot be read by shell');

  job = await propose(windows ? 'Write-Output RUNNING; Start-Sleep -Seconds 30' : 'printf RUNNING; sleep 30');
  const started = Date.now();
  while (!workspace.jobSnapshot(job.id).output.includes('RUNNING')) {
    if (!['queued', 'running'].includes(workspace.job(job.id).state)) throw new Error(workspace.job(job.id).output);
    if (Date.now() - started > 15000) throw new Error('Command did not start.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const shutdownStarted = Date.now(); await workspace.shutdown();
  assert.equal(workspace.job(job.id).state, 'cancelled');
  assert.ok(Date.now() - shutdownStarted < 10000);
  if (windows) assert.deepEqual(await fs.readdir(path.join(data, 'command-workspaces')), []);
  console.log('PASS shutdown cancels running commands and removes staged workspaces');
} finally {
  await workspace.shutdown(); await fs.rm(base, { recursive: true, force: true }); await fs.rm(bundle, { force: true });
}
console.log('5 command service checks passed.');
