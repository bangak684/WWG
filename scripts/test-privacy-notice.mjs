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
const {Store,Workspace,startServer,workspaceInvoker,menuBarTemplate,PRIVACY_NOTICE_VERSION,PRIVACY_NOTICE_SECTIONS}=loaded.exports;
const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wwg-privacy-test-')));
const data=path.join(base,'private'),source=path.join(base,'source');
await fs.mkdir(data);await fs.mkdir(source);
await fs.writeFile(path.join(source,'sample.txt'),'ORIGINAL_FILE_CONTENT_ONLY');
const file=path.join(data,'workspace.json'),store=new Store(file);await store.load();
const workspace=new Workspace(store,data);
let server;
try {
  assert.equal(workspace.snapshot().privacyNoticeAccepted,false);
  await assert.rejects(workspace.addFolders([path.join(base,'nonexistent')]),/처리 안내/);
  await assert.rejects(workspace.enableAutomatic(true,[]),/처리 안내/);
  await assert.rejects(workspace.setEnvironmentNames(['NOT_ALLOWED_YET']),/처리 안내/);
  await assert.rejects(workspace.createTask(randomUUID(),'BEFORE_NOTICE_TASK'),/처리 안내/);
  await assert.rejects(workspace.propose({requestId:randomUUID(),projectId:randomUUID(),kind:'command',command:'BEFORE_NOTICE_COMMAND'}),/처리 안내/);
  await assert.rejects(workspace.acceptPrivacyNotice(PRIVACY_NOTICE_VERSION+1),/다시 확인/);
  assert.equal(store.data.settings.privacyNoticeVersion,0);
  console.log('PASS fresh installations reject grants, settings, changes and stale notice acceptance');

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
  protocol=initialized.protocolVersion;assert.match(initialized.instructions,/Tools cannot acknowledge this notice/);
  const tools=(await rpc('tools/list')).tools;assert.equal(tools.length,16);
  assert.ok(!tools.some(tool=>tool.name.includes('privacy')||tool.name.includes('consent')),'Only the local UI may acknowledge the notice');
  const marker='BEFORE_NOTICE_INPUT_MUST_NOT_PERSIST',requestId=randomUUID(),revision='a'.repeat(64);
  const inputs={
    wwg_status:{},projects_list:{},folders_list:{},files_list:{path:source},file_read:{path:path.join(source,marker)},files_read_batch:{paths:[path.join(source,marker)]},
    file_propose:{requestId,path:path.join(source,marker),content:marker,expectedHash:null},file_patch:{requestId,path:path.join(source,marker),expectedHash:revision,edits:[{oldText:marker,newText:'new'}]},file_delete:{requestId,path:path.join(source,marker),expectedHash:revision},
    command_propose:{requestId,cwd:source,command:marker},task_create:{requestId,title:marker},tasks_list:{},task_get:{taskId:requestId},task_cancel:{taskId:requestId},job_get:{jobId:requestId},logs_list:{}
  };
  for(const tool of tools){
    const result=await rpc('tools/call',{name:tool.name,arguments:inputs[tool.name]});
    assert.equal(result.isError,true,tool.name);assert.match(result.content[0].text,/처리 안내/);
  }
  assert.equal(workspace.lastCall,null);assert.equal(store.data.jobs.length,0);
  assert.ok(!(await fs.readFile(file,'utf8')).includes('BEFORE_NOTICE'));
  console.log('PASS every MCP tool is blocked before acknowledgement without logging request input');

  const menu=menuBarTemplate(workspace.snapshot(),{phase:'stopped'},{});
  assert.equal(menu.find(item=>item.id==='wwg-folders').enabled,false);
  assert.equal(menu.find(item=>item.id==='wwg-automatic').enabled,false);
  await workspace.acceptPrivacyNotice(PRIVACY_NOTICE_VERSION);
  assert.equal(workspace.snapshot().privacyNoticeAccepted,true);
  assert.equal(store.data.settings.approvalMode,'review');
  await workspace.addFolders([source]);
  const invoke=workspaceInvoker(workspace);
  const read=await invoke('file_read',{path:path.join(source,'sample.txt')});assert.equal(read.content,'ORIGINAL_FILE_CONTENT_ONLY');
  const proposal=await workspace.propose({requestId:randomUUID(),projectId:store.data.folders[0].id,kind:'write',path:'sample.txt',content:'PROPOSED_CONTENT_ONLY',expectedHash:read.hash});
  assert.equal(proposal.state,'pending');
  assert.ok((await fs.readFile(file,'utf8')).includes('PROPOSED_CONTENT_ONLY'));
  await workspace.decide(proposal.id,false);
  assert.ok(!(await fs.readFile(file,'utf8')).includes('PROPOSED_CONTENT_ONLY'));
  assert.ok(!(await fs.readFile(file,'utf8')).includes('ORIGINAL_FILE_CONTENT_ONLY'));
  assert.equal(await fs.readFile(path.join(source,'sample.txt'),'utf8'),'ORIGINAL_FILE_CONTENT_ONLY');
  console.log('PASS acknowledgement enables scoped access; pending write contents are purged after decline');

  await workspace.enableAutomatic(true,structuredClone(store.data.folders));
  const restart=new Store(file);await restart.load();
  assert.equal(restart.data.settings.privacyNoticeVersion,PRIVACY_NOTICE_VERSION);
  assert.equal(restart.data.settings.approvalMode,'automatic');
  assert.equal(restart.data.settings.rememberAutomatic,true);
  console.log('PASS current notice acknowledgement persists with explicit automatic-mode opt-in');

  const legacy=structuredClone(restart.data);delete legacy.settings.privacyNoticeVersion;
  await fs.writeFile(file,JSON.stringify(legacy),{mode:0o600});
  const upgraded=new Store(file);await upgraded.load();
  const upgradeWorkspace=new Workspace(upgraded,data);
  try {
    assert.equal(upgraded.data.folders.length,1);assert.ok(upgraded.data.jobs.length>0);
    const locked=upgradeWorkspace.snapshot();assert.equal(locked.privacyNoticeAccepted,false);
    assert.deepEqual(locked.folders,[]);assert.deepEqual(locked.jobs,[]);assert.deepEqual(locked.tasks,[]);
    assert.equal(upgraded.data.settings.approvalMode,'review');assert.equal(upgraded.data.settings.rememberAutomatic,false);
    await assert.rejects(workspaceInvoker(upgradeWorkspace)('projects_list',{}),/처리 안내/);
    await upgradeWorkspace.acceptPrivacyNotice(PRIVACY_NOTICE_VERSION);
    assert.equal(upgradeWorkspace.snapshot().folders.length,1);assert.equal(upgraded.data.settings.approvalMode,'review');
  } finally {await upgradeWorkspace.shutdown();}
  console.log('PASS upgrade preserves grants/history but requires notice and renewed automatic approval');

  const document=await fs.readFile(path.join(root,'PRIVACY.md'),'utf8');
  for(const section of PRIVACY_NOTICE_SECTIONS)assert.ok(document.includes(section.text),section.title);
  console.log('PASS published privacy document matches the notice embedded in the app');
} finally {
  await server?.close();await workspace.shutdown();await fs.rm(base,{recursive:true,force:true});
}
