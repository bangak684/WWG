import type { MenuItemConstructorOptions } from 'electron';
import type { NavigationTarget, Snapshot, TunnelStatus } from '../shared';
export interface MenuBarActions {
  show(target?:NavigationTarget):void|Promise<void>;
  pause(value:boolean):Promise<void>;
  startAutomatic():Promise<void>;stopAutomatic():Promise<void>;selectFolders():Promise<void>;
  stopTunnel():Promise<unknown>;quit():void;error(error:unknown):void;
}
export function menuBarTemplate(snapshot:Snapshot,tunnel:TunnelStatus,actions:MenuBarActions):MenuItemConstructorOptions[] {
  const run=(fn:()=>unknown)=>():void=>{try{void Promise.resolve(fn()).catch(actions.error);}catch(error){actions.error(error);}};
  const pending=snapshot.jobs.filter(job=>job.state==='pending').length;
  const automatic=snapshot.approvalMode==='automatic';
  const activeTasks=snapshot.tasks.filter(task=>['waiting','pending','queued','running','stopping'].includes(task.state)).length;
  const state=!snapshot.privacyNoticeAccepted?'데이터 처리 안내 확인 필요':snapshot.error?'연결 오류':snapshot.paused?'일시 정지':tunnel.phase==='ready'?'ChatGPT 터널 연결됨':'ChatGPT 연결 전';
  return [
    {id:'wwg-status',label:state,enabled:false},
    {id:'wwg-logs',label:pending?`실행 로그 · 승인 대기 ${pending}건`:activeTasks?`실행 로그 · 진행 작업 ${activeTasks}개`:'실행 로그',click:run(()=>actions.show({tab:'logs'}))},
    {id:'wwg-connect',label:'ChatGPT 연결',click:run(()=>actions.show({tab:'connect'}))},
    {type:'separator'},
    {id:'wwg-automatic',label:automatic?'자동승인 끄기 · 수동승인으로 전환':'자동승인 시작…',enabled:snapshot.privacyNoticeAccepted&&!snapshot.paused,click:run(()=>automatic?actions.stopAutomatic():actions.startAutomatic())},
    ...(automatic?[{id:'wwg-automatic-options',label:'자동승인 유지 설정…',enabled:!snapshot.paused,click:run(()=>actions.startAutomatic())}]:[]),
    {id:'wwg-folders',label:`접근 폴더 선택… (${snapshot.folders.length}개)`,enabled:snapshot.privacyNoticeAccepted,click:run(()=>actions.selectFolders())},
    {id:'wwg-settings',label:'접근 설정',click:run(()=>actions.show({tab:'settings'}))},
    {id:'wwg-pause',label:snapshot.paused?'연결 재개':'일시 정지',click:run(()=>actions.pause(!snapshot.paused))},
    ...(tunnel.phase!=='stopped'?[{id:'wwg-stop-tunnel',label:'터널 연결 중지',click:run(()=>actions.stopTunnel())}]:[]),
    {type:'separator'},
    {id:'wwg-show',label:'WWG 열기',click:run(()=>actions.show())},
    {id:'wwg-quit',label:'WWG 완전히 종료',accelerator:'CommandOrControl+Q',click:()=>actions.quit()}
  ];
}
