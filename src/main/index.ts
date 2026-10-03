import { app, BrowserWindow, ipcMain, dialog, clipboard, shell, protocol, net, Tray, Menu } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store } from './store';
import { Workspace } from './service';
import { startServer } from './server';
import { Tunnel } from './tunnel';
import { ensurePrivateDirectory } from './private-io';
import { menuBarTemplate } from './menu-bar';
import { menuBarIcon } from './menu-bar-icon';
import { APP_VERSION, type NavigationTarget } from '../shared';

app.setName('WWG');
// Keep existing project settings and the single-instance lock across the rename.
app.setPath('userData', path.join(app.getPath('appData'), 'Workroom'));
const isolatedTest = process.env.WORKROOM_ISOLATED_TEST === '1';
if ((!app.isPackaged || isolatedTest) && process.env.WORKROOM_DATA_DIR) app.setPath('userData', path.resolve(process.env.WORKROOM_DATA_DIR));
protocol.registerSchemesAsPrivileged([{ scheme: 'workroom', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | null = null;
  let workspace: Workspace | null = null;
  let tunnel: Tunnel | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  let shuttingDown = false;
  let repaint: NodeJS.Timeout | undefined;
  let tray: Tray | undefined;
  let refreshMenu = (): void => {};
  let showWorkspace = async (_target?: NavigationTarget): Promise<void> => { window?.show(); window?.focus(); };
  const rendererDir = path.join(__dirname, '../renderer');
  const appURL = 'workroom://app/index.html';
  const rawDevURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const devURL = rawDevURL ? new URL(rawDevURL) : undefined;
  if (devURL && (devURL.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(devURL.hostname) || devURL.username || devURL.password)) throw new Error('개발 UI 주소는 로컬 HTTP만 허용됩니다.');
  const trustedURL = devURL?.href ?? appURL;
  const notify = (): void => { refreshMenu(); if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('change'); };
  app.on('second-instance', () => { if(!shuttingDown)void showWorkspace().catch(error=>dialog.showErrorBox('WWG',String(error))); });
  app.on('activate', () => { if(!shuttingDown)void showWorkspace().catch(error=>dialog.showErrorBox('WWG',String(error))); });
  app.whenReady().then(async () => {
    protocol.handle('workroom', async request => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'app' || request.method !== 'GET') return new Response(null, { status: 403 });
        const relative = decodeURIComponent(url.pathname);
        if (relative.includes('\\') || relative.includes('\0')) return new Response(null, { status: 403 });
        const target = path.resolve(rendererDir, '.' + relative);
        if (!target.startsWith(rendererDir + path.sep) || !(await fs.lstat(target)).isFile()) return new Response(null, { status: 404 });
        const response = await net.fetch(pathToFileURL(target).href);
        const headers = new Headers(response.headers);
        headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'");
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(response.body, { status: response.status, headers });
      } catch { return new Response(null, { status: 404 }); }
    });
    const dataDir = app.getPath('userData');
    await ensurePrivateDirectory(dataDir);
    const store = new Store(path.join(dataDir, 'workspace.json'));
    await store.load();
    const service = new Workspace(store, dataDir, app.isPackaged ? [process.resourcesPath] : []);
    workspace = service;
    try {
      const port = (!app.isPackaged || isolatedTest) && process.env.WORKROOM_PORT ? Number(process.env.WORKROOM_PORT) : 47831;
      const server = await startServer(service, port); closeServer = server.close;
    } catch (err) { service.error = `연결 서버를 시작하지 못했습니다: ${(err as Error).message}`; }
    service.on('change', () => { if (!repaint) repaint = setTimeout(() => { repaint = undefined; notify(); }, 100); });
    tunnel = new Tunnel(dataDir, !app.isPackaged && process.env.WORKROOM_TUNNEL_CLIENT ? [process.env.WORKROOM_TUNNEL_CLIENT] : undefined);
    tunnel.on('change', notify); await tunnel.inspect();
    const handle = (channel: string, fn: (...args: any[]) => unknown): void => {
      ipcMain.handle(channel, (event, ...args) => {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== trustedURL) throw new Error('허용되지 않은 요청입니다.');
        return fn(...args);
      });
    };
    const id = z.string().uuid();
    const confirm = async (message: string, detail: string, action: string): Promise<boolean> => {
      const result = await dialog.showMessageBox(window!, { type: 'warning', message, detail, buttons: ['취소', action], defaultId: 0, cancelId: 0, noLink: true });
      return result.response === 1;
    };
    handle('snapshot', () => ({ ...service.snapshot(), version: app.isPackaged?app.getVersion():APP_VERSION, runtime: { packaged: app.isPackaged, platform: process.platform, arch: process.arch } }));
    const selectFolders = async (): Promise<void> => {
      const result = await dialog.showOpenDialog(window!, { title:'접근할 폴더 선택', buttonLabel:'접근 허용', properties:['openDirectory','multiSelections'] });
      if (!result.canceled) await service.addFolders(result.filePaths);
    };
    handle('folder:select', selectFolders);
    handle('folder:remove', value => service.removeFolder(id.parse(value)));
    let automaticDialog = false;
    const startAutomatic = async (): Promise<void> => {
      if (automaticDialog) return;
      const folders = structuredClone(store.data.folders);
      if (!folders.length) throw new Error('접근 폴더를 먼저 선택하세요.');
      automaticDialog = true;
      try {
        const scope = folders.flatMap(folder => folder.approvedFolders.map(relative => path.resolve(folder.path,relative))).join('\n');
        const options: Electron.MessageBoxOptions = {
          type:'warning', message:'자동승인을 시작할까요?',
          detail:`접근 범위:\n${scope}\n\n허용한 폴더의 파일 변경·대량 이동·삭제를 추가 확인 없이 실행합니다. 승인 대기 중인 요청도 실행합니다. 셸 명령과 네트워크 사용도 자동승인합니다.${process.platform==='win32'?' Windows 명령은 보호 경로를 제외한 작업 복사본에서 실행하고 결과를 원본에 반영합니다.':''}\n.env*와 허용 범위 밖 접근은 계속 차단됩니다.`,
          buttons:['취소','자동승인 시작'], defaultId:0, cancelId:0, noLink:true,
          checkboxLabel:'다음 실행에도 자동승인 유지', checkboxChecked:store.data.settings.rememberAutomatic
        };
        const result = window?.isVisible() ? await dialog.showMessageBox(window,options) : await dialog.showMessageBox(options);
        if (result.response===1) await service.enableAutomatic(result.checkboxChecked,folders);
      } finally { automaticDialog=false; }
    };
    handle('automatic:start', () => startAutomatic());
    handle('automatic:stop', () => service.disableAutomatic());
    handle('environment:set', names => service.setEnvironmentNames(names));
    handle('logs:clear', async () => {
      if (await confirm('완료된 실행 로그를 비울까요?','화면 밖의 완료 로그와 완료된 작업 묶음도 정리합니다. 요청 대기·승인 대기·실행 중인 작업은 보존하며, 중복 실행 방지 정보는 내부 1,000개 보관 한도 안에서 유지합니다. 이미 ChatGPT에 전달된 내용은 삭제되지 않습니다.','로그 비우기')) await service.clearLogs();
    });
    handle('job:decide', (j,a) => service.decide(id.parse(j),z.boolean().parse(a)));
    handle('job:cancel', j => service.cancel(id.parse(j)));
    handle('task:cancel', t => service.cancelTask(id.parse(t)));
    handle('pause', value => service.setPaused(z.boolean().parse(value)));
    handle('tunnel:status', () => tunnel!.snapshot());
    handle('tunnel:inspect', () => tunnel!.inspect());
    handle('tunnel:start', (tunnelId,key) => { if (service.paused) throw new Error('도구 연결을 재개한 뒤 터널을 연결하세요.'); return tunnel!.start(tunnelId,key,service.endpoint); });
    handle('tunnel:stop', () => tunnel!.stop());
    handle('tunnel:copy-id', () => { const tunnelId = tunnel!.snapshot().tunnelId; if (!tunnelId) throw new Error('터널 ID를 먼저 설정하세요.'); clipboard.writeText(tunnelId); });
    const links = { keys: 'https://platform.openai.com/settings/organization/api-keys', tunnels: 'https://platform.openai.com/settings/organization/tunnels', plugins: 'https://chatgpt.com/plugins', download: 'https://github.com/openai/tunnel-client/releases/latest', guide: 'https://developers.openai.com/api/docs/guides/secure-mcp-tunnels', support:'https://github.com/bangak684/WWG/issues' };
    handle('connection:open', key => shell.openExternal(links[z.enum(['keys','tunnels','plugins','download','guide','support']).parse(key)]));
    let loadingWindow: Promise<BrowserWindow> | undefined;
    const createWindow = (): Promise<BrowserWindow> => {
      if(loadingWindow)return loadingWindow;
      if(window&&!window.isDestroyed())return Promise.resolve(window);
      const win = new BrowserWindow({ show:false, width:1120, height:800, minWidth:820, minHeight:600, title:'WWG', backgroundColor:'#f6f5f1', ...(process.platform==='darwin'?{titleBarStyle:'hiddenInset' as const,trafficLightPosition:{x:20,y:22}}:{}), webPreferences:{ preload:path.join(__dirname,'../preload/index.js'), contextIsolation:true, nodeIntegration:false, sandbox:true, webSecurity:true, devTools:!app.isPackaged||isolatedTest } });
      window=win;
      win.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
      win.webContents.on('will-navigate', e => e.preventDefault());
      win.webContents.on('will-attach-webview', e => e.preventDefault());
      win.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback) => callback(false));
      win.webContents.session.setPermissionCheckHandler(() => false);
      win.webContents.on('render-process-gone', () => { void service.setPaused(true).catch(() => {}); });
      win.on('close', event => {
        if(process.platform==='darwin'&&tray&&!tray.isDestroyed()&&!shuttingDown){event.preventDefault();win.hide();app.dock?.hide();}
        else if(process.platform==='win32'&&!shuttingDown){event.preventDefault();app.quit();}
      });
      win.on('closed', () => { if(window===win)window=null; });
      loadingWindow=win.loadURL(trustedURL).then(() => win).finally(() => {loadingWindow=undefined;});
      return loadingWindow;
    };
    showWorkspace = async target => {
      if(shuttingDown)return;
      const win=await createWindow();
      if(shuttingDown||win.isDestroyed())return;
      if(win.isMinimized())win.restore();
      if(process.platform==='darwin')await app.dock?.show();
      if(shuttingDown||win.isDestroyed())return;
      win.show();win.focus();
      if(target)win.webContents.send('navigate',target);
    };
    if(process.platform==='darwin') {
      tray=new Tray(menuBarIcon());
      let previousMenu='';
      refreshMenu=(): void => {
        if(!tray||tray.isDestroyed()||shuttingDown)return;
        const snapshot=service.snapshot(), status=tunnel!.snapshot();
        const key=JSON.stringify([snapshot.connected,snapshot.paused,snapshot.error,status.phase,snapshot.folders,snapshot.approvalMode,snapshot.rememberAutomatic,snapshot.jobs.map(j=>[j.id,j.projectId,j.state]),snapshot.tasks.map(t=>[t.id,t.state])]);
        if(key===previousMenu)return;
        previousMenu=key;
        const template=menuBarTemplate(snapshot,status,{
          show:target=>showWorkspace(target),pause:value=>service.setPaused(value),
          startAutomatic,stopAutomatic:()=>service.disableAutomatic(),selectFolders:async()=>{await showWorkspace({tab:'settings'});await selectFolders();},stopTunnel:()=>tunnel!.stop(),
          quit:()=>app.quit(),error:error=>dialog.showErrorBox('WWG',error instanceof Error?error.message:String(error))
        });
        tray.setContextMenu(Menu.buildFromTemplate(template));
        tray.setTitle(snapshot.jobs.some(job=>job.state==='pending')?String(snapshot.jobs.filter(job=>job.state==='pending').length):'');
        tray.setToolTip(`WWG · ${snapshot.paused?'일시 정지':snapshot.error?'연결 오류':'MCP 준비됨'}`);
        Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'WWG',submenu:template},{role:'editMenu'}]));
      };
      refreshMenu();
    }
    if(process.platform!=='darwin')Menu.setApplicationMenu(null);
    await createWindow();
    if(process.platform==='darwin'&&store.data.folders.length)app.dock?.hide();
    else await showWorkspace();
  }).catch(err => { dialog.showErrorBox('WWG 시작 오류', (err as Error).message); app.quit(); });
  app.on('window-all-closed', () => { if(!tray&&!shuttingDown)app.quit(); });
  app.on('before-quit', event => {
    if (shuttingDown) return;
    event.preventDefault(); shuttingDown = true;
    tray?.destroy(); tray=undefined;
    if (repaint) clearTimeout(repaint);
    const cleanup = Promise.allSettled([workspace?.shutdown(), tunnel?.stop(), closeServer?.()]);
    const limit = setTimeout(() => app.exit(1), 8000);
    void cleanup.then(() => { clearTimeout(limit); app.quit(); });
  });
}
