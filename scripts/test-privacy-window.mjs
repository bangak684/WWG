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
const fresh=path.join(base,'fresh'),data=path.join(base,'private'),source=path.join(base,'source');
await fs.mkdir(fresh);await fs.mkdir(data);await fs.mkdir(source);
const folderId=randomUUID(),now=Date.now();
await fs.writeFile(path.join(data,'workspace.json'),JSON.stringify({version:2,folders:[{id:folderId,path:source,approvedFolders:['']}],settings:{approvalMode:'automatic',rememberAutomatic:true,environmentNames:['TEST_ALLOWED_TOKEN'],privacyNoticeVersion:0},jobs:[{id:randomUUID(),requestId:randomUUID(),projectId:folderId,kind:'read',state:'done',label:'UI_PRIOR_RECORD',output:'prior-output',createdAt:now,updatedAt:now}],receipts:[],tasks:[]}),{mode:0o600});
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
    const wait=async(code)=>{while(!await evaluate(code)){if(Date.now()>deadline)throw new Error('Settings UI timeout');await new Promise(resolve=>setTimeout(resolve,25));}};
    try {
      await wait("!!document.querySelector('[data-tab=settings]')");
      assert.equal(await evaluate("!!document.querySelector('[data-action=accept-privacy]')"),false);
      assert.equal(await evaluate("!!document.querySelector('.privacy-view')"),false);
      assert.equal(await evaluate("!!document.querySelector('[data-action=select-folders]')"),true);
      const snapshot=await evaluate('window.workroom.snapshot()');assert.equal(snapshot.version,expectedVersion);
      assert.equal('privacyNoticeAccepted' in snapshot,false);
      assert.equal(snapshot.folders.length,stage==='fresh'?0:1);
      assert.equal(snapshot.approvalMode,stage==='fresh'?'review':'automatic');
      if(stage!=='fresh'){assert.equal(snapshot.jobs.length,1);assert.deepEqual(snapshot.environmentNames,['TEST_ALLOWED_TOKEN']);}
      if(process.platform==='darwin'){
        const menu=Menu.getApplicationMenu();assert.equal(menu.getMenuItemById('wwg-folders').enabled,true);assert.equal(menu.getMenuItemById('wwg-automatic').enabled,true);
        menu.getMenuItemById('wwg-settings').click();
      }else{await evaluate("document.querySelector('[data-tab=settings]').click()");}
      while(!window.isVisible()){if(Date.now()>deadline)throw new Error('Settings window was hidden');await new Promise(resolve=>setTimeout(resolve,25));}
      await wait("!!document.querySelector('[data-detail=privacy-notice]')");
      assert.equal(await evaluate("document.querySelector('#environment-form').closest('section').nextElementSibling === document.querySelector('[data-detail=privacy-notice]').closest('section')"),true);
      assert.equal(await evaluate("document.querySelector('[data-detail=privacy-notice]').open"),false);
      await evaluate("document.querySelector('[data-detail=privacy-notice]').open=true;document.querySelector('[data-detail=privacy-notice]').closest('section').scrollIntoView()");
      assert.ok(await evaluate("document.querySelector('[data-detail=privacy-notice]').textContent.includes('정보 전달')"));
      assert.ok(await evaluate("document.querySelector('[data-detail=privacy-notice]').textContent.includes('OS 환경변수 아래')"));
      if(stage==='fresh'){
        await evaluate("document.querySelector('#environment-names').value='TEST_ALLOWED_TOKEN';document.querySelector('#environment-form').requestSubmit()");
        await wait("document.querySelector('#environment-names').value === 'TEST_ALLOWED_TOKEN'");
        const settings=await evaluate('window.workroom.snapshot()');
        while(!settings.environmentNames.includes('TEST_ALLOWED_TOKEN')){if(Date.now()>deadline)throw new Error('Environment settings did not save');settings.environmentNames=(await evaluate('window.workroom.snapshot()')).environmentNames;await new Promise(resolve=>setTimeout(resolve,25));}
      }
      await fs.writeFile(path.join(process.env.WWG_NOTICE_TEST_IMAGES,stage+'-settings.png'),(await window.webContents.capturePage()).toPNG());
      console.log('PASS actual '+stage+' app starts without a notice gate and shows the notice below OS environment settings');
      app.quit();
    }catch(error){console.error(error.stack);app.exit(2);}
  });
});
require('./index.js');
`);
  for(const stage of ['fresh','upgrade','restart']){
    const env={...process.env,WORKROOM_ISOLATED_TEST:'1',WORKROOM_DATA_DIR:stage==='fresh'?fresh:data,WORKROOM_PORT:'0',WWG_NOTICE_TEST_STAGE:stage,WWG_NOTICE_TEST_IMAGES:base};
    delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
    let output='';
    child=spawn(createRequire(import.meta.url)('electron'),[harness],{cwd:root,env,windowsHide:false,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
    const watchdog=setTimeout(()=>child.kill(),20000);
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(watchdog));
    assert.equal(code,0,output);assert.ok(output.includes('PASS actual'),output);
    console.log(output.split('\n').filter(line=>line.startsWith('PASS')).join('\n'));
  }
  const saved=JSON.parse(await fs.readFile(path.join(data,'workspace.json'),'utf8'));
  assert.ok(!('privacyNoticeVersion' in saved.settings));assert.equal(saved.settings.approvalMode,'automatic');assert.equal(saved.settings.rememberAutomatic,true);
  if(keepImages)console.log('UI screenshots: '+base);
}finally{
  child?.kill();await fs.rm(harness,{force:true});
  if(!keepImages)await fs.rm(base,{recursive:true,force:true});
}
