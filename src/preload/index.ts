import { contextBridge, ipcRenderer } from 'electron';
import type { WorkroomAPI, NavigationTarget } from '../shared';
const api: WorkroomAPI = {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  selectFolders: () => ipcRenderer.invoke('folder:select'),
  removeFolder: id => ipcRenderer.invoke('folder:remove',id),
  startAutomatic: () => ipcRenderer.invoke('automatic:start'),
  stopAutomatic: () => ipcRenderer.invoke('automatic:stop'),
  setEnvironmentNames: names => ipcRenderer.invoke('environment:set',names),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  decide: (id,accept) => ipcRenderer.invoke('job:decide',id,accept),
  cancelJob: id => ipcRenderer.invoke('job:cancel',id),
  cancelTask: id => ipcRenderer.invoke('task:cancel',id),
  pause: value => ipcRenderer.invoke('pause',value),
  tunnelStatus: () => ipcRenderer.invoke('tunnel:status'),
  inspectTunnel: () => ipcRenderer.invoke('tunnel:inspect'),
  startTunnel: (id,key) => ipcRenderer.invoke('tunnel:start',id,key),
  stopTunnel: () => ipcRenderer.invoke('tunnel:stop'),
  openConnectionLink: link => ipcRenderer.invoke('connection:open',link),
  copyTunnelId: () => ipcRenderer.invoke('tunnel:copy-id'),
  onChange: callback => { const handler=():void=>callback();ipcRenderer.on('change',handler);return()=>ipcRenderer.removeListener('change',handler); },
  onNavigate: callback => { const handler=(_event:Electron.IpcRendererEvent,target:NavigationTarget):void=>callback(target);ipcRenderer.on('navigate',handler);return()=>ipcRenderer.removeListener('navigate',handler); }
};
contextBridge.exposeInMainWorld('workroom',api);
