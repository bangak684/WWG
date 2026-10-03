import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const packageVersion=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version;
const base=await fs.mkdtemp(path.join(os.tmpdir(),'wwg-privacy-window-'));
const data=path.join(base,'private'),source=path.join(base,'source');
await fs.mkdir(data);await fs.mkdir(source);
const folderId=randomUUID(),now=Date.now();
await fs.writeFile(path.join(data,'workspace.json'),JSON.stringify({version:2,folders:[{id:folderId,path:source,approvedFolders:['']}],settings:{approvalMode:'automatic',rememberAutomatic:true,environmentNames:[]},jobs:[{id:randomUUID(),requestId:randomUUID(),projectId:folderId,kind:'read',state:'done',label:'UI_PRIOR_RECORD',output:'prior-output',createdAt:now,updatedAt:now}],receipts:[],tasks:[]}),{mode:0o600});
const harness=path.join(root,'out','main','privacy-window-test.cjs');
let child;
const keepImages=process.env.WWG_KEEP_TEST_IMAGES==='1';
try {
  await fs.writeFile(harness,`const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {app,dialog,Menu}=require('electron');
dialog.showErrorBox=(_title,message)=>{console.error(message);app.exit(2);};
const stage=process.env.WWG_NOTICE_TEST_STAGE;
const expectedVersion=${JSON.stringify(packageVersion)};
const deadline=Date.now()+15000;
app.once('browser-window-created',(_event,window)=>{
  window.webContents.once('did-finish-load',async()=>{
    const evaluate=code=>window.webContents.executeJavaScript(code);
    const wait=async(code)=>{while(!await evaluate(code)){if(Date.now()>deadline)throw new Error('Notice UI timeout');await new Promise(resolve=>setTimeout(resolve,25));}};
    try {
      if(stage==='first'){
        await wait("!!document.querySelector('[data-action=accept-privacy]')");
        while(!window.isVisible()){if(Date.now()>deadline)throw new Error('First notice window was hidden');await new Promise(resolve=>setTimeout(resolve,25));}
        assert.equal(await evaluate("!!document.querySelector('[data-action=select-folders]')"),false);
        assert.equal(await evaluate("!!document.querySelector('#tunnel-form')"),false);
        const initial=await evaluate('window.workroom.snapshot()');assert.equal(initial.version,expectedVersion);assert.equal(initial.privacyNoticeAccepted,false);assert.equal(initial.folders.length,0);assert.equal(initial.jobs.length,0);
        for(const call of ["window.workroom.selectFolders()","window.workroom.startAutomatic()","window.workroom.startTunnel('invalid-test-tunnel','fake-test-key')"]){
          const error=await evaluate("(async()=>{try{await "+call+";return '';}catch(error){return error.message;}})()");assert.match(error,/처리 안내/);
        }
        if(process.platform==='darwin'){const menu=Menu.getApplicationMenu();assert.equal(menu.getMenuItemById('wwg-folders').enabled,false);assert.equal(menu.getMenuItemById('wwg-automatic').enabled,false);}
        await fs.writeFile(path.join(process.env.WWG_NOTICE_TEST_IMAGES,'notice.png'),(await window.webContents.capturePage()).toPNG());
        await evaluate("document.querySelector('.privacy-actions').scrollIntoView({block:'end'})");
        assert.equal(await evaluate("document.querySelector('[data-action=accept-privacy]').getBoundingClientRect().bottom <= innerHeight-29"),true);
        await fs.writeFile(path.join(process.env.WWG_NOTICE_TEST_IMAGES,'notice-actions.png'),(await window.webContents.capturePage()).toPNG());
        await evaluate("document.querySelector('[data-action=accept-privacy]').click()");
        await wait("!!document.querySelector('[data-action=select-folders]')");
        const accepted=await evaluate('window.workroom.snapshot()');assert.equal(accepted.privacyNoticeAccepted,true);assert.equal(accepted.approvalMode,'review');assert.equal(accepted.folders.length,1);assert.equal(accepted.jobs.length,1);
        await evaluate("document.querySelector('[data-tab=settings]').click()");
        await wait("!!document.querySelector('[data-detail=privacy-notice]')");
        assert.ok(await evaluate("document.querySelector('[data-detail=privacy-notice]').textContent.includes('정보 전달')"));
        await evaluate("document.querySelector('[data-detail=privacy-notice]').open=true;document.querySelector('[data-detail=privacy-notice]').scrollIntoView()");
        await fs.writeFile(path.join(process.env.WWG_NOTICE_TEST_IMAGES,'settings-notice.png'),(await window.webContents.capturePage()).toPNG());
        console.log('PASS actual upgrade window shows notice, gates controls and accepts through trusted IPC');
      }else{
        await wait("!!document.querySelector('[data-action=select-folders]')");
        assert.equal(await evaluate("!!document.querySelector('[data-action=accept-privacy]')"),false);
        const snapshot=await evaluate('window.workroom.snapshot()');assert.equal(snapshot.version,expectedVersion);assert.equal(snapshot.privacyNoticeAccepted,true);assert.equal(snapshot.approvalMode,'review');assert.equal(snapshot.folders.length,1);
        console.log('PASS actual app restart preserves acknowledgement and stays in manual mode');
      }
      app.quit();
    }catch(error){console.error(error.stack);app.exit(2);}
  });
});
require('./index.js');
`);
  for(const stage of ['first','restart']){
    const env={...process.env,WORKROOM_ISOLATED_TEST:'1',WORKROOM_DATA_DIR:data,WORKROOM_PORT:'0',WWG_NOTICE_TEST_STAGE:stage,WWG_NOTICE_TEST_IMAGES:base};
    delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
    let output='';
    child=spawn(createRequire(import.meta.url)('electron'),[harness],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    const watchdog=setTimeout(()=>child.kill(),20000);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(watchdog));
    assert.equal(code,0,output);assert.ok(output.includes('PASS actual'),output);
    console.log(output.split('\n').filter(line=>line.startsWith('PASS')).join('\n'));
  }
  const saved=JSON.parse(await fs.readFile(path.join(data,'workspace.json'),'utf8'));
  assert.equal(saved.settings.privacyNoticeVersion,1);assert.equal(saved.settings.approvalMode,'review');assert.equal(saved.settings.rememberAutomatic,false);
  if(keepImages)console.log('UI screenshots: '+base);
}finally{
  child?.kill();await fs.rm(harness,{force:true});
  if(!keepImages)await fs.rm(base,{recursive:true,force:true});
}
