import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildWindowsRunner } from './build-windows-runner.mjs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'out', 'main', 'windows-command-test.cjs');
await build({ entryPoints: [path.join(root, 'src', 'main', 'windows-command.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['original-fs'] });
const { WindowsCommandWorkspace, windowsRunnerPath } = createRequire(import.meta.url)(bundle);
if (process.platform === 'win32') await buildWindowsRunner();
let passed = 0;
const failures = [];
async function test(name, fn) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wwg-windows-test-')));
  const source = path.join(base, 'source'), second = path.join(base, 'second'), data = path.join(base, 'private'), outside = path.join(base, 'outside');
  await Promise.all([source, second, data, outside].map(value => fs.mkdir(value)));
  await fs.writeFile(path.join(source, 'safe.txt'), 'original');
  await fs.writeFile(path.join(source, '.env'), 'PRIVATE_ENV_MUST_NOT_BE_COPIED');
  let workspace;
  const fixture = { source, second, data, outside, prepare: async (authorized = () => true) => workspace = await WindowsCommandWorkspace.prepare([source, second], data, authorized, [data]) };
  try { await fn(fixture); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); }
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
  await test('NTFS alternate data streams are never copied', async ({ source, prepare }) => {
    await fs.writeFile(path.join(source, 'safe.txt') + ':private', 'PRIVATE_ADS_SENTINEL');
    const workspace = await prepare();
    assert.equal(await exists(workspace.mappedPath(path.join(source, 'safe.txt')) + ':private'), false);
    assert.equal(await fs.readFile(path.join(source, 'safe.txt') + ':private', 'utf8'), 'PRIVATE_ADS_SENTINEL');
  });
  await test('public package permissions on source folders cannot bypass isolation', async ({ source, prepare }) => {
    await promisify(execFile)(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'), [source, '/grant', '*S-1-15-2-2:(OI)(CI)RX']);
    const workspace = await prepare();
    const result = await execute(workspace, source, 'Write-Output UNEXPECTED_EXECUTION');
    assert.equal(result.code, 125, result.output);
    assert.match(result.output, /permissions bypass isolation/);
    assert.ok(!result.output.includes('UNEXPECTED_EXECUTION'));
  });
  await test('public package permissions on secret files reject execution', async ({ source, prepare }) => {
    await promisify(execFile)(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'), [path.join(source, '.env'), '/grant', '*S-1-15-2-2:RX']);
    const workspace = await prepare();
    const result = await execute(workspace, source, 'Write-Output UNEXPECTED_EXECUTION');
    assert.equal(result.code, 125, result.output);
    assert.match(result.output, /permissions bypass isolation/);
  });
  await test('LPAC cmd runs and safe writes synchronize', async ({ source, prepare }) => {
    const workspace = await prepare();
    const result = await execute(workspace, source, 'cmd /d /c "echo LPAC-cmd-ok> command.txt"');
    assert.equal(result.code, 0, result.output);
    await workspace.synchronize();
    assert.match(await fs.readFile(path.join(source, 'command.txt'), 'utf8'), /LPAC-cmd-ok/);
  });
  await test('LPAC blocks ungranted user files, direct host access, host writes and existing .env', async ({ source, outside, prepare }) => {
    await fs.writeFile(path.join(outside, 'private.txt'), 'HOST_PRIVATE_SENTINEL');
    const workspace = await prepare();
    const result = await execute(workspace, source, `try{Get-Content '${path.join(outside, 'private.txt')}';exit 91}catch{Write-Output DENIED_PRIVATE};try{Get-Content .env;exit 92}catch{Write-Output DENIED_ENV};try{[IO.File]::WriteAllText('${path.join(outside, 'written.txt')}','BAD');exit 93}catch{Write-Output DENIED_WRITE}`);
    assert.equal(result.code, 0, result.output);
    for (const marker of ['DENIED_PRIVATE', 'DENIED_ENV', 'DENIED_WRITE']) assert.ok(result.output.includes(marker), result.output);
    assert.ok(!result.output.includes('HOST_PRIVATE_SENTINEL'));
    assert.ok(!result.output.includes('PRIVATE_ENV_MUST_NOT_BE_COPIED'));
    assert.equal(await exists(path.join(outside, 'written.txt')), false);
    // Even granted originals have no LPAC ACL; avoid literal path mapping by using an env value.
    const direct = await execute(workspace, source, 'Get-Content -LiteralPath $env:ORIGINAL_HOST_FILE', { ORIGINAL_HOST_FILE: path.join(source, 'safe.txt') });
    assert.notEqual(direct.code, 0, direct.output);
    assert.ok(!direct.output.includes('original'));
  });
  await test('LPAC does not inherit environment variables and receives only selected values', async ({ source, prepare }) => {
    process.env.WWG_UNREQUESTED_SECRET = 'DO_NOT_INHERIT';
    const workspace = await prepare();
    const result = await execute(workspace, source, "if($env:WWG_UNREQUESTED_SECRET){exit 9};[IO.File]::WriteAllText('selected.txt',$env:SELECTED_VALUE)", { SELECTED_VALUE: 'explicit' });
    delete process.env.WWG_UNREQUESTED_SECRET;
    assert.equal(result.code, 0, result.output);
    await workspace.synchronize();
    assert.match(await fs.readFile(path.join(source, 'selected.txt'), 'utf8'), /explicit/);
  });
  await test('LPAC PowerShell can move and delete copied files and folders', async ({ source, prepare }) => {
    const workspace = await prepare();
    const result = await execute(workspace, source, 'try{New-Item -ItemType Directory bulk | Out-Null; Move-Item safe.txt bulk\\moved.txt; Remove-Item bulk -Recurse -Force}catch{Write-Output $_.Exception.ToString();throw}');
    assert.equal(result.code, 0, result.output);
    await workspace.synchronize();
    assert.equal(await exists(path.join(source, 'safe.txt')), false);
  });
  await test('LPAC PowerShell runs without profiles', async ({ source, prepare }) => {
    const workspace = await prepare();
    const result = await execute(workspace, source, "[IO.File]::WriteAllText('powershell.txt','powershell-ok')");
    assert.equal(result.code, 0, result.output);
    await workspace.synchronize();
    assert.equal(await fs.readFile(path.join(source, 'powershell.txt'), 'utf8'), 'powershell-ok');
  });
  await test('Unicode scripts, file paths and output retain UTF-8 text', async ({ source, prepare }) => {
    const workspace = await prepare();
    const result = await execute(workspace, source, "[IO.File]::WriteAllText('한글 이름.txt','한글 내용'); Write-Output '한글 출력'");
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /한글 출력/);
    await workspace.synchronize();
    assert.equal(await fs.readFile(path.join(source, '한글 이름.txt'), 'utf8'), '한글 내용');
  });
  await test('COM shell activation cannot copy ungranted private files', async ({ source, outside, prepare }) => {
    await fs.writeFile(path.join(outside, 'private.txt'), 'PRIVATE_BROKER_SENTINEL');
    const workspace = await prepare();
    const result = await execute(workspace, source, `try{$shell=New-Object -ComObject Shell.Application;$shell.NameSpace((Get-Location).ProviderPath).CopyHere('${path.join(outside, 'private.txt')}',20)}catch{};Start-Sleep -Seconds 1;if(Test-Path private.txt){exit 9}`);
    assert.equal(result.code, 0, result.output);
    assert.equal(await exists(workspace.mappedPath(path.join(source, 'private.txt'))), false);
  });
  await test('LPAC standard Node.js runtime executes with no host PATH inheritance', async ({ source, prepare }) => {
    const workspace = await prepare();
    const result = await execute(workspace, source, `node -e "require('fs').writeFileSync('node.txt','node-ok')"`);
    assert.equal(result.code, 0, result.output);
    await workspace.synchronize();
    assert.equal(await fs.readFile(path.join(source, 'node.txt'), 'utf8'), 'node-ok');
  });
  await test('native descendants cannot regain ALL_APPLICATION_PACKAGES access', async ({ source, outside, prepare }) => {
    const privateFile = path.join(outside, 'private.txt');
    await fs.writeFile(privateFile, 'PRIVATE_ALL_PACKAGES_SENTINEL');
    await promisify(execFile)(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'), [privateFile, '/grant', '*S-1-15-2-1:RX']);
    const workspace = await prepare();
    const result = await execute(workspace, source, `node -e "try{process.stdout.write(require('fs').readFileSync(process.env.HOST_PATH,'utf8'))}catch{process.exit(13)}"`, { HOST_PATH: privateFile });
    assert.equal(result.code, 13, result.output);
    assert.ok(!result.output.includes('PRIVATE_ALL_PACKAGES_SENTINEL'));
  });
  await test('closing the job stops background descendants before publication', async ({ source, prepare }) => {
    const workspace = await prepare();
    const result = await execute(workspace, source, `cmd /d /c 'start "" /b powershell -NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 2; [IO.File]::WriteAllText(''orphan.txt'',''BAD'')"'`);
    assert.equal(result.code, 0, result.output);
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal(await exists(workspace.mappedPath(path.join(source, 'orphan.txt'))), false);
  });
  await test('forced parent exit stops its command and releases the temporary drive', async ({ source, data }) => {
    const script = path.join(data, 'parent.cjs');
    await fs.writeFile(script, `const { WindowsCommandWorkspace } = require(${JSON.stringify(bundle)});
(async () => {
  const workspace = await WindowsCommandWorkspace.prepare([${JSON.stringify(source)}], ${JSON.stringify(data)}, () => true, [${JSON.stringify(data)}]);
  await workspace.prepareRuntimes('Write-Output RUNNING');
  const child = workspace.spawn(${JSON.stringify(source)}, "Write-Output RUNNING; Start-Sleep -Seconds 30; [IO.File]::WriteAllText('orphan.txt','BAD')", {});
  let output = '', sent = false;
  child.stdout.on('data', bytes => {
    output += bytes;
    if (!sent && output.includes('RUNNING')) {
      sent = true;
      process.send({ pid: child.pid, profile: workspace.profile, stage: workspace.stage, drive: output.match(/WWGDRIVE:([D-Z]:)/)[1] });
    }
  });
  child.stderr.pipe(process.stderr);
})().catch(error => { console.error(error); process.exit(1); });
`);
    const parent = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '', info;
    parent.stdout.on('data', bytes => output += bytes); parent.stderr.on('data', bytes => output += bytes);
    try {
      info = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Nested command did not start: ' + output)), 30000);
        parent.once('message', value => { clearTimeout(timer); resolve(value); });
        parent.once('error', error => { clearTimeout(timer); reject(error); });
        parent.once('exit', () => { clearTimeout(timer); reject(new Error('Parent exited before readiness: ' + output)); });
      });
      const exited = new Promise(resolve => parent.once('exit', resolve)); parent.kill(); await exited;
      const deadline = Date.now() + 10000;
      while (true) {
        try { process.kill(info.pid, 0); }
        catch (error) { if (error.code === 'ESRCH') break; throw error; }
        if (Date.now() >= deadline) throw new Error('The launcher survived its parent.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(await exists(info.drive + '\\'), false);
      assert.equal(await exists(path.join(info.stage, 'folders', '0', 'orphan.txt')), false);
    } finally {
      parent.kill();
      if (info) {
        try { process.kill(info.pid); } catch {}
        await promisify(execFile)(windowsRunnerPath(), ['--cleanup', info.profile, info.stage]);
      }
    }
  });
} else console.log('Windows native LPAC tests run on Windows CI.');
await fs.rm(bundle, { force: true });
console.log(`${passed} Windows command checks passed.`);
assert.deepEqual(failures, [], 'Windows command verification failed.');
