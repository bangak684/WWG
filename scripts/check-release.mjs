import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFile(path.join(root,file),'utf8');
const pkg=JSON.parse(await read('package.json'));
const lock=JSON.parse(await read('package-lock.json'));
assert.equal(pkg.name,lock.name,'Package/lock name mismatch');
assert.equal(pkg.name,lock.packages[''].name,'Lock root name mismatch');
assert.equal(pkg.version,lock.version,'Package/lock version mismatch');
assert.equal(pkg.version,lock.packages[''].version,'Lock root version mismatch');
assert.ok((await read('src/shared.ts')).includes(`APP_VERSION = '${pkg.version}'`),'App version mismatch');
for(const group of ['dependencies','devDependencies'])assert.deepEqual(pkg[group],lock.packages[''][group],'Lock dependency mismatch');
for(const file of ['README.md','LICENSE','electron-builder.config.cjs','build/entitlements.mac.plist','build/icon.icns','build/icon.ico','scripts/release-files.mjs'])assert.ok((await fs.stat(path.join(root,file))).size>0,`Missing build file: ${file}`);
console.log(`WWG ${pkg.version}: version, dependencies and build files checked.`);
