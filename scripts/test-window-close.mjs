import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

if (process.platform !== 'win32') throw new Error('This check exercises Windows close-to-quit behavior.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wwg-close-test-'));
const harness = path.join(root, 'out', 'main', 'window-close-test.cjs');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const connect = () => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.end(); resolve(); });
  socket.once('error', reject);
});
let output = '', child, connected;
try {
  // Load the real built application and close its real BrowserWindow.
  await fs.writeFile(harness, `const { app, dialog } = require('electron');
dialog.showErrorBox = (_title, message) => { console.error(message); app.exit(2); };
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    console.log('WWG_WINDOW_READY');
    setTimeout(() => window.close(), 1000);
  });
});
app.once('quit', () => console.log('WWG_QUIT_COMPLETE'));
require('./index.js');
`);
  const env = { ...process.env, WORKROOM_ISOLATED_TEST: '1', WORKROOM_DATA_DIR: base, WORKROOM_PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  child = spawn(createRequire(import.meta.url)('electron'), [harness], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const watchdog = setTimeout(() => child.kill(), 20000);
  const started = Date.now();
  const collect = chunk => {
    output += chunk;
    if (output.includes('WWG_WINDOW_READY') && !connected) connected = connect().then(() => true, error => error);
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(watchdog));
  assert.equal(code, 0, output);
  assert.ok(output.includes('WWG_QUIT_COMPLETE'), output);
  assert.equal(await connected, true, 'The app must have started its MCP listener before closing.');
  assert.ok(Date.now() - started < 20000, 'Closing the window must finish application shutdown.');
  await assert.rejects(connect(), { code: 'ECONNREFUSED' });
  console.log('PASS closing the actual Windows window exits WWG and closes its MCP listener');
} finally {
  child?.kill();
  await fs.rm(harness, { force: true });
  await fs.rm(base, { recursive: true, force: true });
}
