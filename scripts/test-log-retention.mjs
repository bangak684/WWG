import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({ stdin:{ contents:"export { Store } from './src/main/store'; export { Workspace } from './src/main/service'; export { retainHistory, visibleLogs } from './src/main/log-retention'; export { workspaceInvoker } from './src/main/tools'; export { startServer } from './src/main/server'; export { emptyTaskCounts } from './src/main/tasks';", resolveDir:root, loader:'ts' }, bundle:true, write:false, platform:'node', format:'cjs', external:['zod','original-fs','@modelcontextprotocol/server','@modelcontextprotocol/node'] });
const loaded = new Module(path.join(root,'__log_retention_test.cjs'));
loaded.filename = loaded.id; loaded.paths = Module._nodeModulePaths(root);
loaded._compile(bundled.outputFiles[0].text,loaded.filename);
const { Store, Workspace, retainHistory, visibleLogs, workspaceInvoker, startServer, emptyTaskCounts } = loaded.exports;
const projectId = randomUUID();
const makeJob = (n, state='done', kind='command') => ({ id:randomUUID(), requestId:randomUUID(), projectId, kind, state, command:kind==='command'?`command-${n}`:undefined, label:`label-${n}`, output:`output-${n}`, createdAt:n+1, updatedAt:n+1 });
const receipt = job => Object.fromEntries(['id','requestId','projectId','taskId','requestHash','kind','state','createdAt','updatedAt'].filter(key=>job[key]!==undefined).map(key=>[key,job[key]]));
const task = (title,counts=emptyTaskCounts()) => ({ id:randomUUID(), title, counts, createdAt:1, updatedAt:1 });
const settings = { approvalMode:'review', environmentNames:[], rememberAutomatic:false };
const workspaces = [];
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'wwg-log-retention-')));
const storeAt = async name => { const dir=path.join(base,name); await fs.mkdir(dir); const store=new Store(path.join(dir,'workspace.json')); await store.load(); await store.update(d=>{d.settings.privacyNoticeVersion=1;}); return store; };
const workspaceFor = (store,name) => { const workspace=new Workspace(store,path.join(base,name)); workspaces.push(workspace); return workspace; };

try {
  const mcpStore=await storeAt('mcp'), mcpWorkspace=workspaceFor(mcpStore,'mcp');
  const server=await startServer(mcpWorkspace,0);
  try {
    let protocol='2025-11-25', rpcId=0;
    const rpc=async(method,params={})=>{
      const response=await fetch(mcpWorkspace.endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':protocol},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})});
      assert.equal(response.status,200);
      const body=await response.text();
      const messages=response.headers.get('content-type')?.includes('text/event-stream')
        ? body.split(/\r?\n\r?\n/).map(frame=>frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean).map(data=>JSON.parse(data))
        : [JSON.parse(body)];
      const message=messages.find(message=>message.id===rpcId); assert.ok(message,'MCP response missing');
      assert.ok(!message.error,JSON.stringify(message.error));
      return message.result;
    };
    const initialized=await rpc('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'WWG retention test',version:'1.0.0'}});
    protocol=initialized.protocolVersion;
    const tools=(await rpc('tools/list')).tools;
    assert.equal(tools.length,16);
    const changes=new Set(['file_propose','file_patch','file_delete','command_propose']);
    for(const tool of tools){
      const annotations=tool.annotations;
      assert.equal(annotations.idempotentHint,annotations.readOnlyHint||tool.name==='task_cancel',tool.name);
      assert.equal(annotations.destructiveHint,changes.has(tool.name)||tool.name==='task_cancel',tool.name);
      assert.equal(annotations.openWorldHint,tool.name==='command_propose',tool.name);
      if(changes.has(tool.name))assert.match(tool.description,/repeating the same request can execute it again/);
    }
    assert.match(tools.find(tool=>tool.name==='logs_list').description,/no age-based expiry/);
    assert.match(tools.find(tool=>tool.name==='task_create').description,/only while it is retained/);
    console.log('PASS MCP tools/list exposes conservative retry hints and accurate retention descriptions');
  } finally {await server.close();}

  const oldTask=task('expired-group',{...emptyTaskCounts(),done:100});
  const liveTask=task('retained-group',{...emptyTaskCounts(),done:1000,failed:1});
  const jobs=Array.from({length:1101},(_,n)=>({...makeJob(n,n===100?'failed':'done'),taskId:n<100?oldTask.id:liveTask.id})).reverse();
  const expired=jobs.filter(job=>job.createdAt<=101);
  const history={ jobs, receipts:jobs.map(receipt).reverse(), tasks:[oldTask,liveTask] };
  retainHistory(history);
  assert.equal(history.jobs.length,1000); assert.equal(history.receipts.length,1000);
  assert.equal(new Set([...history.jobs,...history.receipts].map(record=>record.id)).size,1000);
  assert.deepEqual(history.tasks.map(task=>task.title),['retained-group']);
  assert.deepEqual(history.tasks[0].counts,{...emptyTaskCounts(),done:1000});
  for(const job of expired) assert.ok(!JSON.stringify(history).includes(job.id));
  assert.deepEqual(visibleLogs(history.jobs).map(job=>job.id),history.jobs.slice(0,200).map(job=>job.id));
  console.log('PASS 200 visible / 1,000 stored; expired jobs, receipts, task counts and orphaned titles removed');

  const active=[makeJob(-2,'pending'),makeJob(-1,'running')];
  const mixed={jobs:[...Array.from({length:1200},(_,n)=>makeJob(n)).reverse(),...active],receipts:active.map(receipt),tasks:[]};
  retainHistory(mixed);
  assert.equal(mixed.jobs.length,1000);
  const visible=visibleLogs(mixed.jobs);
  assert.equal(visible.length,200);
  for(const job of active) assert.ok(visible.some(entry=>entry.id===job.id));
  assert.equal(visible.filter(job=>job.state==='done').length,198);
  assert.throws(()=>retainHistory({jobs:Array.from({length:201},(_,n)=>makeJob(n,'pending')),receipts:[],tasks:[]}),/200/);
  console.log('PASS older pending/running requests preserved and visible; active queue remains bounded');

  const diskStore=await storeAt('disk');
  await diskStore.update(d=>{d.jobs=history.jobs;d.receipts=history.receipts;d.tasks=history.tasks;});
  const workspace=workspaceFor(diskStore,'disk'), invoke=workspaceInvoker(workspace);
  const archived=diskStore.data.jobs[300];
  assert.ok(!workspace.snapshot().jobs.some(job=>job.id===archived.id));
  assert.equal((await invoke('job_get',{jobId:archived.id})).id,archived.id);
  assert.equal((await invoke('task_get',{taskId:liveTask.id,limit:100})).retainedRequests,1000);
  assert.throws(()=>workspace.job(expired[0].id),/삭제/);
  const restarted=new Store(path.join(base,'disk','workspace.json')); await restarted.load();
  assert.equal(restarted.data.jobs.length,1000);
  for(const job of expired) assert.ok(!JSON.stringify(restarted.data).includes(job.id));
  console.log('PASS archive lookup and restart keep only retained history; expired IDs stay absent');

  const legacyJobs=Array.from({length:10000},(_,n)=>makeJob(n));
  const legacyDir=path.join(base,'legacy'); await fs.mkdir(legacyDir);
  await fs.writeFile(path.join(legacyDir,'workspace.json'),JSON.stringify({version:2,folders:[],settings,jobs:legacyJobs.slice(-200).reverse(),receipts:legacyJobs.map(receipt),tasks:[]}),{mode:0o600});
  const legacy=new Store(path.join(legacyDir,'workspace.json')); await legacy.load();
  assert.equal(legacy.data.receipts.length,1000);
  assert.ok(!legacy.data.receipts.some(entry=>entry.id===legacyJobs[8999].id));
  const legacyWorkspace=workspaceFor(legacy,'legacy');
  assert.equal(legacyWorkspace.job(legacyJobs[9000].id).state,'done');
  await legacy.update(d=>{d.jobs.unshift(...Array.from({length:1100},(_,n)=>makeJob(10001+n,'done','read')).reverse());});
  assert.equal(legacy.data.jobs.length,1000); assert.equal(legacy.data.receipts.length,0);
  assert.throws(()=>legacyWorkspace.job(legacyJobs[9000].id),/삭제/);
  console.log('PASS old 10,000-receipt settings migrate; read requests expire older command receipts too');

  const clearStore=await storeAt('clear'), clearWorkspace=workspaceFor(clearStore,'clear');
  const completed=Array.from({length:1000},(_,n)=>makeJob(n));
  const waiting=makeJob(-5,'pending');
  await clearStore.update(d=>{d.jobs=[...completed.reverse(),waiting];d.receipts=d.jobs.map(receipt);});
  assert.equal(clearWorkspace.snapshot().jobs.length,200);
  assert.equal(clearWorkspace.snapshot().canClearLogs,true);
  await clearWorkspace.clearLogs();
  assert.deepEqual(clearStore.data.jobs.map(job=>job.id),[waiting.id]);
  assert.equal(clearStore.data.receipts.length,1000);
  assert.equal(clearWorkspace.snapshot().canClearLogs,false);
  await clearStore.update(d=>{d.jobs.unshift(...Array.from({length:1000},(_,n)=>makeJob(2000+n,'done','read')).reverse());});
  assert.equal(clearStore.data.receipts.length,1);
  assert.equal(clearStore.data.receipts[0].id,waiting.id);
  assert.equal(clearWorkspace.snapshot().jobs.some(job=>job.id===waiting.id),true);
  console.log('PASS manual clear includes hidden logs, preserves active work and bounds remaining retry receipts');

  const retryStore=await storeAt('retry'), retryWorkspace=workspaceFor(retryStore,'retry');
  const source=path.join(base,'source'); await fs.mkdir(source); await retryWorkspace.addFolders([source]);
  const request={requestId:randomUUID(),projectId:retryStore.data.folders[0].id,kind:'write',path:'new.txt',content:'pending',expectedHash:null};
  const first=await retryWorkspace.propose(request), repeated=await retryWorkspace.propose(request);
  assert.equal(first.id,repeated.id); assert.equal(retryStore.data.jobs.length,1);
  await assert.rejects(retryWorkspace.propose({...request,content:'different'}),/requestId/);
  await retryWorkspace.decide(first.id,false);
  await retryStore.update(d=>{d.jobs.unshift(...Array.from({length:1000},(_,n)=>makeJob(Date.now()+n,'done','read')).reverse());});
  assert.equal(retryStore.data.receipts.length,0);
  assert.throws(()=>retryWorkspace.job(first.id),/삭제/);
  await assert.rejects(fs.stat(path.join(source,'new.txt')),{code:'ENOENT'});
  console.log('PASS retained retries stay idempotent; expired request fingerprints are removed without replay');

  const large=await storeAt('large');
  await large.update(d=>{d.jobs=Array.from({length:1000},(_,n)=>({...makeJob(n),command:'x'.repeat(4000),label:'x'.repeat(4000),output:'o'.repeat(32000)})).reverse();});
  assert.ok((await fs.stat(path.join(base,'large','workspace.json'))).size>32*1024*1024);
  const largeReload=new Store(path.join(base,'large','workspace.json'));await largeReload.load();
  assert.equal(largeReload.data.jobs.length,1000);
  assert.equal(largeReload.data.jobs[999].output.length,32000);
  console.log('PASS 1,000 full outputs above the former 32MiB limit persist and reload');

  const burst=await storeAt('burst'), burstWorkspace=workspaceFor(burst,'burst');
  for(let n=0;n<1200;n++)burstWorkspace.audit('file_read',true,`read-${n}`,'read');
  await burst.flushLazy();
  assert.equal(burst.data.jobs.length,1000);
  assert.equal(burst.data.jobs[0].label,'read-1199');
  assert.equal(burst.data.jobs[999].label,'read-200');
  console.log('PASS burst read logging retains the latest 1,000 requests');
} finally {
  for(const workspace of workspaces)await workspace.shutdown();
  await fs.rm(base,{recursive:true,force:true});
}
