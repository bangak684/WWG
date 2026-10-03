import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildWindowsRunner } from './build-windows-runner.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'out', 'main', 'windows-command-test.cjs');
await build({ entryPoints: [path.join(root, 'src', 'main', 'windows-command.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['original-fs'] });
const { WindowsCommandWorkspace } = createRequire(import.meta.url)(bundle);
if (process.platform === 'win32') await buildWindowsRunner();
let passed = 0;
async function test(name, fn) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wwg-windows-test-')));
  const source = path.join(base, 'source'), second = path.join(base, 'second'), data = path.join(base, 'private'), outside = path.join(base, 'outside');
  await Promise.all([source, second, data, outside].map(value => fs.mkdir(value)));
  await fs.writeFile(path.join(source, 'safe.txt'), 'original');
  await fs.writeFile(path.join(source, '.env'), 'PRIVATE_ENV_MUST_NOT_BE_COPIED');
  let workspace;
  const fixture = { source, second, data, outside, prepare: async (authorized = () => true) => workspace = await WindowsCommandWorkspace.prepare([source, second], data, authorized, [data]) };
  try { await fn(fixture); passed++; console.log(`PASS ${name}`); }
  finally { await workspace?.dispose(); await fs.rm(base, { recursive: true, force: true }); }
}
const exists = async target => { try { await fs.lstat(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

await test('host secrets never enter the workspace; ordinary binary files do', async ({ source, prepare }) => {
  await fs.writeFile(path.join(source, 'data.bin'), Buffer.from([0, 1, 255]));
  const workspace = await prepare(), copy = workspace.mappedPath(source);
  assert.equal(await exists(path.join(copy, '.env')), false);
  assert.deepEqual(await fs.readFile(path.join(copy, 'data.bin')), Buffer.from([0, 1, 255]));
});
await test('secret hard-link aliases are excluded without opening their contents', async ({ source, prepare }) => {
  await fs.link(path.join(source, '.env'), path.join(source, 'looks-safe.txt'));
  const workspace = await prepare();
  assert.equal(await exists(workspace.mappedPath(path.join(source, 'looks-safe.txt'))), false);
});
await test('unaccounted external hard-link aliases are excluded', async ({ source, outside, prepare }) => {
  await fs.writeFile(path.join(outside, 'private.txt'), 'private');
  await fs.link(path.join(outside, 'private.txt'), path.join(source, 'alias.txt'));
  const workspace = await prepare();
  assert.equal(await exists(workspace.mappedPath(path.join(source, 'alias.txt'))), false);
});
await test('fully accounted ordinary hard links work for bulk deletion', async ({ source, prepare }) => {
  await fs.link(path.join(source, 'safe.txt'), path.join(source, 'second.txt'));
  const workspace = await prepare();
  await fs.unlink(workspace.mappedPath(path.join(source, 'safe.txt')));
  await fs.unlink(workspace.mappedPath(path.join(source, 'second.txt')));
  await workspace.synchronize();
  assert.equal(await exists(path.join(source, 'safe.txt')), false);
  assert.equal(await exists(path.join(source, 'second.txt')), false);
});
await test('hard-link groups fully inside multiple grants work for bulk deletion', async ({ source, second, prepare }) => {
  await fs.link(path.join(source, 'safe.txt'), path.join(second, 'linked.txt'));
  const workspace = await prepare();
  await fs.unlink(workspace.mappedPath(path.join(source, 'safe.txt')));
  await fs.unlink(workspace.mappedPath(path.join(second, 'linked.txt')));
  await workspace.synchronize();
  assert.equal(await exists(path.join(source, 'safe.txt')), false);
  assert.equal(await exists(path.join(second, 'linked.txt')), false);
});
await test('junctions/symlinks do not bring outside files into the workspace', async ({ source, outside, prepare }) => {
  await fs.writeFile(path.join(outside, 'private.txt'), 'private');
  await fs.symlink(outside, path.join(source, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const workspace = await prepare();
  assert.equal(await exists(workspace.mappedPath(path.join(source, 'alias'))), false);
});
await test('binary replacement, directory creation, cross-folder movement and deletion synchronize', async ({ source, second, prepare }) => {
  await fs.mkdir(path.join(source, 'remove'));
  await fs.writeFile(path.join(source, 'remove', 'old.bin'), Buffer.from([0, 10]));
  const workspace = await prepare();
  await fs.mkdir(workspace.mappedPath(path.join(second, 'new')));
  await fs.rename(workspace.mappedPath(path.join(source, 'safe.txt')), workspace.mappedPath(path.join(second, 'new', 'moved.txt')));
  await fs.rm(workspace.mappedPath(path.join(source, 'remove')), { recursive: true });
  await fs.writeFile(workspace.mappedPath(path.join(second, 'new', 'new.bin')), Buffer.from([0, 200]));
  await workspace.synchronize();
  assert.equal(await exists(path.join(source, 'safe.txt')), false);
  assert.equal(await exists(path.join(source, 'remove')), false);
  assert.equal(await fs.readFile(path.join(second, 'new', 'moved.txt'), 'utf8'), 'original');
  assert.deepEqual(await fs.readFile(path.join(second, 'new', 'new.bin')), Buffer.from([0, 200]));
  assert.equal(await fs.readFile(path.join(source, '.env'), 'utf8'), 'PRIVATE_ENV_MUST_NOT_BE_COPIED');
});
await test('new secret paths reject all publication before safe files change', async ({ source, prepare }) => {
  const workspace = await prepare();
  await fs.writeFile(workspace.mappedPath(path.join(source, 'safe.txt')), 'changed');
  await fs.writeFile(workspace.mappedPath(path.join(source, '.env.new')), 'generated');
  await assert.rejects(workspace.synchronize(), /비밀파일/);
  assert.equal(await fs.readFile(path.join(source, 'safe.txt'), 'utf8'), 'original');
});
await test('removing a parent containing an excluded secret rejects publication', async ({ source, prepare }) => {
  await fs.mkdir(path.join(source, 'folder'));
  await fs.writeFile(path.join(source, 'folder', '.env.local'), 'private');
  await fs.writeFile(path.join(source, 'folder', 'safe.txt'), 'safe');
  const workspace = await prepare();
  await fs.rm(workspace.mappedPath(path.join(source, 'folder')), { recursive: true });
  await assert.rejects(workspace.synchronize(), /이동·삭제/);
  assert.equal(await fs.readFile(path.join(source, 'folder', '.env.local'), 'utf8'), 'private');
});
await test('source edits made during the command are not overwritten', async ({ source, prepare }) => {
  const workspace = await prepare();
  await fs.writeFile(workspace.mappedPath(path.join(source, 'safe.txt')), 'command');
  await fs.writeFile(path.join(source, 'safe.txt'), 'user edit');
  await assert.rejects(workspace.synchronize(), /원본.*변경/);
  assert.equal(await fs.readFile(path.join(source, 'safe.txt'), 'utf8'), 'user edit');
});
await test('a source-parent replacement with a symlink is rejected', async ({ source, outside, prepare }) => {
  await fs.mkdir(path.join(source, 'folder'));
  await fs.writeFile(path.join(source, 'folder', 'safe.txt'), 'safe');
  const workspace = await prepare();
  await fs.writeFile(workspace.mappedPath(path.join(source, 'folder', 'safe.txt')), 'command');
  await fs.rm(path.join(source, 'folder'), { recursive: true });
  await fs.symlink(outside, path.join(source, 'folder'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspace.synchronize(), /경로.*변경/);
  assert.equal(await exists(path.join(outside, 'safe.txt')), false);
});
await test('new result hard links cannot alias host files', async ({ source, outside, prepare }) => {
  await fs.writeFile(path.join(outside, 'private.txt'), 'private');
  const workspace = await prepare();
  await fs.link(path.join(outside, 'private.txt'), workspace.mappedPath(path.join(source, 'new.txt')));
  await assert.rejects(workspace.synchronize(), /하드링크/);
  assert.equal(await exists(path.join(source, 'new.txt')), false);
});
await test('revocation discards pending changes', async ({ source, prepare }) => {
  let allowed = true;
  const workspace = await prepare(() => allowed);
  await fs.writeFile(workspace.mappedPath(path.join(source, 'safe.txt')), 'changed');
  allowed = false;
  await assert.rejects(workspace.synchronize(), /권한.*취소/);
  assert.equal(await fs.readFile(path.join(source, 'safe.txt'), 'utf8'), 'original');
});
await test('grant roots are mapped in commands with a case-insensitive boundary', async ({ source, second, prepare }) => {
  const workspace = await prepare();
  const actual = workspace.mappedCommand(`move "${source.toUpperCase()}${path.sep}safe.txt" "${second.replaceAll('\\', '/')}"`);
  assert.ok(actual.includes(workspace.mappedPath(source)));
  assert.ok(actual.includes(workspace.mappedPath(second)));
  assert.equal(workspace.mappedCommand(`echo "${source}-ungranted"`), `echo "${source}-ungranted"`);
});

async function execute(workspace, cwd, command, selected = {}) {
  await workspace.prepareRuntimes(command);
  const child = workspace.spawn(cwd, command, selected);
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  const timer = setTimeout(() => child.kill(), 45000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, output };
  } finally { clearTimeout(timer); }
}

if (process.platform === 'win32') {
  await test('LPAC cmd runs and safe writes synchronize', async ({ source, prepare }) => {
    const workspace = await prepare();
    const result = await execute(workspace, source, 'echo LPAC-cmd-ok> command.txt');
    assert.equal(result.code, 0, result.output);
    await workspace.synchronize();
    assert.match(await fs.readFile(path.join(source, 'command.txt'), 'utf8'), /LPAC-cmd-ok/);
  });
  await test('LPAC blocks ungranted user files, direct host access, host writes and existing .env', async ({ source, outside, prepare }) => {
    await fs.writeFile(path.join(outside, 'private.txt'), 'HOST_PRIVATE_SENTINEL');
    const workspace = await prepare();
    const result = await execute(workspace, source, `type "${path.join(outside, 'private.txt')}" & type .env & echo BAD> "${path.join(outside, 'written.txt')}"`);
    assert.notEqual(result.code, 0, result.output);
    assert.ok(!result.output.includes('HOST_PRIVATE_SENTINEL'));
    assert.ok(!result.output.includes('PRIVATE_ENV_MUST_NOT_BE_COPIED'));
    assert.equal(await exists(path.join(outside, 'written.txt')), false);
    // Even granted originals have no LPAC ACL; avoid literal path mapping by using an env value.
    const direct = await execute(workspace, source, 'type "%ORIGINAL_HOST_FILE%"', { ORIGINAL_HOST_FILE: path.join(source, 'safe.txt') });
    assert.notEqual(direct.code, 0, direct.output);
    assert.ok(!direct.output.includes('original'));
  });
  await test('LPAC does not inherit environment variables and receives only selected values', async ({ source, prepare }) => {
    process.env.WWG_UNREQUESTED_SECRET = 'DO_NOT_INHERIT';
    const workspace = await prepare();
    const result = await execute(workspace, source, 'if defined WWG_UNREQUESTED_SECRET (exit /b 9) else (echo %SELECTED_VALUE%> selected.txt)', { SELECTED_VALUE: 'explicit' });
    delete process.env.WWG_UNREQUESTED_SECRET;
    assert.equal(result.code, 0, result.output);
    await workspace.synchronize();
    assert.match(await fs.readFile(path.join(source, 'selected.txt'), 'utf8'), /explicit/);
  });
  await test('LPAC PowerShell runs without profiles', async ({ source, prepare }) => {
    const workspace = await prepare();
    const result = await execute(workspace, source, `powershell -NoLogo -NoProfile -NonInteractive -Command "[IO.File]::WriteAllText('powershell.txt','powershell-ok')"`);
    assert.equal(result.code, 0, result.output);
    await workspace.synchronize();
    assert.equal(await fs.readFile(path.join(source, 'powershell.txt'), 'utf8'), 'powershell-ok');
  });
  await test('LPAC standard Node.js runtime executes with no host PATH inheritance', async ({ source, prepare }) => {
    const workspace = await prepare();
    const result = await execute(workspace, source, `node -e "require('fs').writeFileSync('node.txt','node-ok')"`);
    assert.equal(result.code, 0, result.output);
    await workspace.synchronize();
    assert.equal(await fs.readFile(path.join(source, 'node.txt'), 'utf8'), 'node-ok');
  });
  await test('closing the job stops background descendants before publication', async ({ source, prepare }) => {
    const workspace = await prepare();
    const result = await execute(workspace, source, `start "" /b powershell -NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 2; [IO.File]::WriteAllText('orphan.txt','BAD')"`);
    assert.equal(result.code, 0, result.output);
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal(await exists(workspace.mappedPath(path.join(source, 'orphan.txt'))), false);
  });
} else console.log('Windows native LPAC tests run on Windows CI.');
await fs.rm(bundle, { force: true });
console.log(`${passed} Windows command checks passed.`);
