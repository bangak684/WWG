import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bundled=await build({stdin:{contents:"export { Store } from './src/main/store'; export { Workspace } from './src/main/service'; export { startServer } from './src/main/server'; export { workspaceInvoker } from './src/main/tools'; export { menuBarTemplate } from './src/main/menu-bar'; export * from './src/privacy-notice';",resolveDir:root,loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',external:['zod','original-fs','@modelcontextprotocol/server','@modelcontextprotocol/node']});
const loaded=new Module(path.join(root,'__privacy_test.cjs'));
loaded.filename=loaded.id;loaded.paths=Module._nodeModulePaths(root);loaded._compile(bundled.outputFiles[0].text,loaded.filename);
const {Store,Workspace,startServer,workspaceInvoker,menuBarTemplate,PRIVACY_NOTICE_SECTIONS}=loaded.exports;
const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wwg-privacy-test-')));
const data=path.join(base,'private'),source=path.join(base,'source');
await fs.mkdir(data);await fs.mkdir(source);
await fs.writeFile(path.join(source,'sample.txt'),'ORIGINAL_FILE_CONTENT_ONLY');
await fs.writeFile(path.join(source,'.env'),'BLOCKED_PRIVATE_FIXTURE');
await fs.writeFile(path.join(base,'outside.txt'),'UNGRANTED_FIXTURE');
const file=path.join(data,'workspace.json'),store=new Store(file);await store.load();
const workspace=new Workspace(store,data);
let server;
try {
  assert.equal(store.data.settings.approvalMode,'review');
  assert.ok(!('privacyNoticeAccepted' in workspace.snapshot()));
  await workspace.setEnvironmentNames(['TEST_ALLOWED_TOKEN']);
  await workspace.addFolders([source]);
  const task=await workspace.createTask(randomUUID(),'NOTICE_IS_INFORMATIONAL');
  const invoke=workspaceInvoker(workspace);
  const read=await invoke('file_read',{path:path.join(source,'sample.txt'),taskId:task.id});
  assert.equal(read.content,'ORIGINAL_FILE_CONTENT_ONLY');
  assert.equal(workspace.snapshot().folders.length,1);
  assert.deepEqual(workspace.snapshot().environmentNames,['TEST_ALLOWED_TOKEN']);
  await assert.rejects(invoke('file_read',{path:path.join(source,'.env')}));
  await assert.rejects(invoke('file_read',{path:path.join(base,'outside.txt')}));
  const proposal=await workspace.propose({requestId:randomUUID(),projectId:store.data.folders[0].id,kind:'write',path:'sample.txt',content:'PROPOSED_CONTENT_ONLY',expectedHash:read.hash});
  assert.equal(proposal.state,'pending');
  assert.equal(await fs.readFile(path.join(source,'sample.txt'),'utf8'),'ORIGINAL_FILE_CONTENT_ONLY');
  await workspace.decide(proposal.id,false);
  assert.ok(!(await fs.readFile(file,'utf8')).includes('PROPOSED_CONTENT_ONLY'));
  assert.ok(!(await fs.readFile(file,'utf8')).includes('ORIGINAL_FILE_CONTENT_ONLY'));
  console.log('PASS fresh use requires no notice acknowledgement; grants, protected paths and manual approval still apply');

  server=await startServer(workspace,0);
  let protocol='2025-11-25',id=0;
  const rpc=async(method,params={})=>{
    const response=await fetch(workspace.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':protocol},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
    assert.equal(response.status,200);
    const body=await response.text();
    const messages=response.headers.get('content-type')?.includes('text/event-stream')
      ? body.split(/\r?\n\r?\n/).map(frame=>frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean).map(data=>JSON.parse(data))
      : [JSON.parse(body)];
    const message=messages.find(message=>message.id===id);assert.ok(message);assert.ok(!message.error,JSON.stringify(message.error));return message.result;
  };
  const initialized=await rpc('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'WWG privacy test',version:'1.0.0'}});
  protocol=initialized.protocolVersion;assert.match(initialized.instructions,/notice is available in Access settings/);
  assert.ok(!initialized.instructions.includes('must first acknowledge'));
  const tools=(await rpc('tools/list')).tools;assert.equal(tools.length,16);
  assert.ok(!tools.some(tool=>tool.name.includes('privacy')||tool.name.includes('consent')));
  const projects=await rpc('tools/call',{name:'projects_list',arguments:{}});assert.ok(!projects.isError);
  assert.equal(JSON.parse(projects.content[0].text)[0].path,source);
  const fileRead=await rpc('tools/call',{name:'file_read',arguments:{path:path.join(source,'sample.txt')}});assert.ok(!fileRead.isError);
  assert.equal(JSON.parse(fileRead.content[0].text).content,'ORIGINAL_FILE_CONTENT_ONLY');
  const menu=menuBarTemplate(workspace.snapshot(),{phase:'stopped'},{});
  assert.notEqual(menu.find(item=>item.id==='wwg-folders').enabled,false);
  assert.equal(menu.find(item=>item.id==='wwg-automatic').enabled,true);
  console.log('PASS real HTTP MCP and menu controls work without an acknowledgement step');

  await workspace.enableAutomatic(true,structuredClone(store.data.folders));
  await store.flushLazy();
  const legacy=structuredClone(store.data);
  for(const noticeVersion of [undefined,0,1]){
    const prior=structuredClone(legacy);
    if(noticeVersion!==undefined)prior.settings.privacyNoticeVersion=noticeVersion;
    await fs.writeFile(file,JSON.stringify(prior),{mode:0o600});
    const upgraded=new Store(file);await upgraded.load();
    const upgradeWorkspace=new Workspace(upgraded,data);
    try {
      assert.equal(upgradeWorkspace.snapshot().folders.length,1);assert.ok(upgradeWorkspace.snapshot().jobs.length>0);
      assert.equal(upgraded.data.settings.approvalMode,'automatic');assert.equal(upgraded.data.settings.rememberAutomatic,true);
      assert.ok(!('privacyNoticeVersion' in upgraded.data.settings));
      assert.ok(!('privacyNoticeVersion' in JSON.parse(await fs.readFile(file,'utf8')).settings));
      assert.equal((await workspaceInvoker(upgradeWorkspace)('projects_list',{})).length,1);
    }finally{await upgradeWorkspace.shutdown();}
  }
  const transient=structuredClone(legacy);transient.settings.rememberAutomatic=false;
  await fs.writeFile(file,JSON.stringify(transient),{mode:0o600});
  const restart=new Store(file);await restart.load();assert.equal(restart.data.settings.approvalMode,'review');
  console.log('PASS old notice fields are removed while existing grants, logs and explicit persistent approval are preserved');

  const document=(await fs.readFile(path.join(root,'PRIVACY.md'),'utf8')).replace(/\r\n/g,'\n');
  for(const section of PRIVACY_NOTICE_SECTIONS)assert.ok(document.includes(section.text),section.title);
  assert.ok(document.includes('OS 환경변수 아래'));
  assert.ok(!document.includes('안내 확인 버전'));
  console.log('PASS published privacy text matches the notice available in settings');
}finally{
  await server?.close();await workspace.shutdown();await fs.rm(base,{recursive:true,force:true});
}
