import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRelease, writeReleaseManifest } from './release-files.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const allowed=['--mac','--win','--signed','--prepare','--check-credentials'];
if(args.some(arg=>!allowed.includes(arg))||(args.includes('--mac')&&args.includes('--win')))throw new Error('Unknown or conflicting release option');
const { output, version }=await prepareRelease(root);
if(args.includes('--prepare')) {
  console.log(`Release notes: release/${version}/RELEASE.md`);process.exit(0);
}
const windows=args.includes('--win'),signed=args.includes('--signed');
if(windows ? process.platform!=='win32'||process.arch!=='x64' : process.platform!=='darwin'||process.arch!=='arm64')
  throw new Error(windows?'Build Windows x64 on Windows x64.':'Build macOS Apple Silicon on macOS arm64.');
if(signed&&windows)throw new Error('The signed release option is for macOS.');
if(signed) {
  const signing=!!(process.env.CSC_LINK||process.env.CSC_NAME);
  const notary=!!(process.env.APPLE_ID&&process.env.APPLE_APP_SPECIFIC_PASSWORD&&process.env.APPLE_TEAM_ID)
    ||!!(process.env.APPLE_API_KEY&&process.env.APPLE_API_KEY_ID&&process.env.APPLE_API_ISSUER)
    ||!!process.env.APPLE_KEYCHAIN_PROFILE;
  if(!signing||!notary)throw new Error('Developer ID signing and notarization credentials must be configured.');
}
if(args.includes('--check-credentials')) {
  if(!signed)throw new Error('Use --signed with --check-credentials.');
  console.log('Signing configuration is present.');process.exit(0);
}
async function run(executable,arguments_,extra={}) {
  await new Promise((resolve,reject)=>{
    const child=spawn(executable,arguments_,{cwd:root,env:{...process.env,...extra},stdio:'inherit',windowsHide:true});
    child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`Release step failed: ${path.basename(executable)} (${code})`)));
  });
}
const node=(script,arguments_=[],extra={})=>run(process.execPath,[path.join(root,script),...arguments_],extra);
await node('scripts/check-release.mjs');
await node('node_modules/electron-vite/bin/electron-vite.js',['build']);
const arch=windows?'x64':'arm64',prefix=`WWG-${version}-${arch}`;
for(const name of await fs.readdir(output))if(name.startsWith(prefix)&&/^(?:-portable)?(?:-preview)?\.(?:dmg|exe|zip)(?:\.blockmap)?$/.test(name.slice(prefix.length)))await fs.rm(path.join(output,name));
await node('node_modules/electron-builder/out/cli/cli.js',['--config','electron-builder.config.cjs',windows?'--win':'--mac',windows?'--x64':'--arm64','--publish','never'],{
  WORKROOM_SIGNED_RELEASE:signed?'1':'0',...(windows?{CSC_IDENTITY_AUTO_DISCOVERY:'false'}:{})
});
const unpacked=path.join(output,windows?'win-unpacked':'mac-arm64');
const app=path.join(unpacked,windows?'WWG.exe':'WWG.app');await fs.access(app);
if(!windows) {
  await run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  if(signed) {
    await run('/usr/sbin/spctl',['--assess','--type','execute',app]);
    await run('/usr/bin/xcrun',['stapler','validate',app]);
  }
}
await writeReleaseManifest(root,{platform:windows?'win32':'darwin',arch,signing:windows?'unsigned':signed?'Developer ID':'ad-hoc',notarized:signed,...(windows?{distribution:'portable'}:{})});
await fs.rm(unpacked,{recursive:true,force:true});
for(const name of await fs.readdir(output))if(name.endsWith('.blockmap')||/^builder-.*\.ya?ml$/.test(name))await fs.rm(path.join(output,name));
console.log(`Release files ready: release/${version}/`);
