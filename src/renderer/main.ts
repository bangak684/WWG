import './style.css';
import type { Snapshot, Job, TaskSnapshot, TaskState, TunnelStatus, ConnectionLink, NavigationTarget } from '../shared';
const api = window.workroom, root = document.querySelector<HTMLDivElement>('#app')!;
let data: Snapshot;
let tunnel: TunnelStatus = {installed:false,phase:'stopped',tunnelId:'',message:''};
let tab: NavigationTarget['tab'] = 'logs';
let initialized = false, tunnelBusy = false, onlyPending = false, limit = 40;
let toastTimer: ReturnType<typeof setTimeout>;
const details = new Set<string>();
const collapsedTasks = new Set<string>();
const escape = (value:unknown):string => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const labels: Record<Job['state'],string> = {pending:'승인 대기',queued:'실행 대기',running:'실행 중',done:'완료',failed:'실패 / 차단',declined:'거절',cancelled:'중지됨'};
const taskLabels: Record<TaskState,string> = {waiting:'요청 대기',pending:'승인 대기',queued:'실행 대기',running:'실행 중',stopping:'중지 중',done:'요청 완료',failed:'실패 / 거절',cancelled:'중지됨'};
const kinds: Record<Job['kind'],string> = {command:'명령',write:'파일 변경',delete:'파일 삭제',read:'파일 조회',request:'요청',access:'접근 요청'};
const toolLabels:Record<string,string> = {files_list:'폴더 조회',file_read:'파일 읽기',files_read_batch:'파일 일괄 읽기',file_propose:'파일 변경',file_patch:'파일 수정',file_delete:'파일 삭제',command_propose:'명령 실행'};
function toast(message:string):void {
  const node = document.querySelector('#toast')!;
  node.textContent = message.replace(/^Error invoking remote method '[^']+': (Error: )?/,'');
  node.classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>node.classList.remove('visible'),6000);
}
async function action(fn:()=>Promise<unknown>):Promise<void> { try { await fn(); await refresh(); } catch(error) { toast((error as Error).message); } }
let refreshing:Promise<void>|undefined, again=false;
async function refresh():Promise<void> {
  again=true; if(refreshing)return refreshing;
  refreshing=(async()=>{
    do {
      again=false; [data,tunnel]=await Promise.all([api.snapshot(),api.tunnelStatus()]);
      if(!initialized){initialized=true;if(!data.folders.length&&tunnel.phase!=='ready')tab='connect';}
      render();
    }while(again);
  })();
  try{await refreshing;}finally{refreshing=undefined;}
}
function navigate(next:NavigationTarget['tab']):void {
  tab=next;render();root.querySelector('.content')?.scrollTo(0,0);
  const heading=root.querySelector<HTMLElement>('.content h1');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
}
function logCard(job:Job):string {
  const pending=job.state==='pending';
  const active=job.state==='queued'||job.state==='running';
  const changed=job.kind==='write'&&pending&&job.content!==undefined;
  return `<article class="log-card" data-job="${job.id}"><div class="log-meta"><span class="kind">${escape(toolLabels[job.tool??'']??kinds[job.kind])}</span><time datetime="${new Date(job.createdAt).toISOString()}">${new Date(job.createdAt).toLocaleString('ko-KR')}</time><span class="state ${job.state}">${labels[job.state]}</span></div><pre class="request">${escape(job.label)}</pre>${job.kind==='command'&&job.directory?`<div class="directory">실행 위치 · <code>${escape(job.directory)}</code></div>`:''}${changed?`<details data-detail="${job.id}" ${details.has(job.id)?'open':''}><summary>변경 내용 확인</summary><div class="diff"><div><h3>변경 전</h3><pre>${escape(job.before??'(새 파일)')}</pre></div><div><h3>변경 후</h3><pre>${escape(job.content)}</pre></div></div></details>`:''}${job.output?`<details data-detail="output-${job.id}" ${details.has('output-'+job.id)||job.state==='failed'?'open':''}><summary>${active?'현재 출력':'실행 결과'}${job.exitCode!==undefined&&job.exitCode!==null?` · 종료 코드 ${job.exitCode}`:''}</summary><pre class="output">${escape(job.output)}</pre></details>`:''}${pending?`<div class="approval"><span>실행 전 수동승인이 필요합니다.</span><button data-decline="${job.id}">거절</button><button class="primary" data-approve="${job.id}" ${data.paused?'disabled':''}>승인 후 실행</button></div>`:active?`<div class="execution-actions"><button data-cancel="${job.id}">실행 중지</button></div>`:''}</article>`;
}
function logsView():string {
  const logs=data.jobs.filter(job=>!onlyPending||job.state==='pending');
  const visible=logs.slice(0,limit), groups=data.tasks.filter(task=>visible.some(job=>job.taskId===task.id)||(!onlyPending&&!data.jobs.some(job=>job.taskId===task.id)));
  const units=[...groups.map(task=>({time:task.updatedAt,html:taskGroup(task,visible.filter(job=>job.taskId===task.id))})),...visible.filter(job=>!job.taskId).map(job=>({time:job.createdAt,html:logCard(job)}))].sort((a,b)=>b.time-a.time);
  const clearable=data.jobs.some(job=>!['pending','queued','running'].includes(job.state))||data.tasks.some(task=>['done','failed','cancelled'].includes(task.state));
  return `<div class="section-heading"><div><h1>실행 로그</h1><p>관련 요청은 작업별로 묶어 표시합니다. 작업을 펼쳐 결과와 필요한 승인을 확인하세요.</p></div><button class="quiet" data-action="clear-logs" ${clearable?'':'disabled'}>완료 로그 비우기</button></div><div class="log-filters"><button data-filter="all" aria-pressed="${!onlyPending}">전체</button><button data-filter="pending" aria-pressed="${onlyPending}">승인 대기 ${data.jobs.filter(job=>job.state==='pending').length}</button></div>${units.length?`<div class="logs">${units.map(unit=>unit.html).join('')}</div>${logs.length>limit?'<button class="more" data-action="more">이전 로그 더 보기</button>':''}`:`<div class="empty"><span>⌘</span><h2>${onlyPending?'승인이 필요한 요청이 없습니다.':'아직 받은 요청이 없습니다.'}</h2><p>${onlyPending?'요청이 도착하면 이곳에 승인 버튼이 표시됩니다.':'접근 폴더를 선택하고 웹 ChatGPT에서 작업을 요청하세요.'}</p></div>`}<p class="retention">최근 요청 200개와 작업 묶음 100개를 보관합니다. 요청 완료는 현재까지 등록된 요청의 실행 결과입니다. 파일 조회 내용은 저장하지 않습니다.</p>`;
}
function taskGroup(task:TaskSnapshot,jobs:Job[]):string {
  const active=['waiting','pending','queued','running','stopping'].includes(task.state), key='task-'+task.id;
  const open=details.has(key)||(active&&!collapsedTasks.has(task.id));
  const errors=task.counts.failed+task.counts.declined, archived=task.totalRequests-task.retainedRequests;
  return `<details class="task-group" data-task="${task.id}" data-detail="${key}" ${open?'open':''}><summary><span class="task-title">${escape(task.title)}</span><span class="task-count">완료 ${task.counts.done} / 요청 ${task.totalRequests}${errors?` · 실패·거절 ${errors}`:''}</span><span class="state ${task.state}">${taskLabels[task.state]}</span></summary><div class="task-body"><div class="task-actions">${task.cancelledAt===undefined&&active?`<button data-cancel-task="${task.id}">작업 중지</button>`:''}</div>${task.checkpoint?`<div class="task-checkpoint"><strong>작업 기억</strong><p>${escape(task.checkpoint.summary)}</p>${task.checkpoint.nextSteps.length?`<ul>${task.checkpoint.nextSteps.map(step=>`<li>${escape(step)}</li>`).join('')}</ul>`:''}</div>`:''}${task.memory.length&&(task.retainedRequests<task.totalRequests||task.memory.some(entry=>entry.taskId!==task.id))?`<details><summary>저장된 파일·명령 결과 ${task.memory.length}개</summary>${task.memory.map(entry=>`<div class="memory-entry"><span class="state ${entry.state}">${labels[entry.state]}</span><code>${escape(entry.command??entry.path??entry.tool)}</code>${entry.output?`<p>${escape(entry.output)}</p>`:''}</div>`).join('')}</details>`:''}${jobs.map(logCard).join('')||'<p class="task-empty">'+(task.totalRequests?'표시할 상세 요청 로그가 없습니다.':'ChatGPT의 다음 파일·명령 요청을 기다립니다.')+'</p>'}${archived?`<p class="task-note">이전 요청 ${archived}개의 상세 로그는 정리됐으며 결과 수는 유지합니다.</p>`:''}${jobs.length<task.retainedRequests?'<p class="task-note">다른 요청은 전체 필터 또는 이전 로그에서 확인할 수 있습니다.</p>':''}</div></details>`;
}
function connectionView():string {
  const active=tunnel.phase!=='stopped', locked=active||tunnelBusy;
  return `<div class="section-heading"><div><h1>웹 ChatGPT 연결</h1><p>WWG를 맞춤형 MCP 서버로 등록하고, 터널을 통해 웹 ChatGPT에서 사용합니다.</p></div><button data-link="guide">공식 안내 ↗</button></div>
  <div class="connect-layout"><section class="panel"><h2>1. 연결 정보 준비</h2><p>OpenAI Platform에서 터널과 런타임 API 키를 준비합니다. 터널에는 사용할 ChatGPT 워크스페이스를 연결하세요.</p><div class="buttons"><button data-link="tunnels">터널 만들기 ↗</button><button data-link="keys">API 키 발급 ↗</button></div><p class="note">키에는 Tunnels Read + Use 권한이 필요합니다. WWG는 이 키로 터널을 인증하며 모델 API를 호출하지 않습니다.</p><div class="install-status"><span>${tunnel.installed?'✓ tunnel-client 설치 확인됨':'tunnel-client 설치 필요'}</span><button data-action="inspect">설치 확인</button>${!tunnel.installed?'<button data-link="download">다운로드 ↗</button>':''}</div>
  <h2>2. WWG에서 터널 연결</h2><form id="tunnel-form" autocomplete="off"><label for="tunnel-id">터널 ID</label><input id="tunnel-id" name="tunnelId" value="${escape(tunnel.tunnelId)}" required placeholder="tunnel_…" spellcheck="false" autocomplete="off" ${locked?'disabled':''}><label for="tunnel-key">런타임 API 키</label><input id="tunnel-key" name="apiKey" type="password" required placeholder="sk-…" spellcheck="false" autocomplete="off" ${locked?'disabled':''}><p class="note">API 키는 저장하지 않고 연결을 요청하면 입력란을 비웁니다. 앱을 다시 실행할 때는 키를 다시 입력하세요.</p><button class="primary" type="submit" ${locked||!tunnel.installed||!data.connected||data.paused?'disabled':''}>${tunnelBusy?'연결 중…':'터널 연결'}</button></form><div class="tunnel-state ${tunnel.phase}" role="status"><strong>${{stopped:'연결 전',starting:'연결 중',ready:'터널 연결됨',error:'연결 오류'}[tunnel.phase]}</strong><p>${escape(tunnel.message)}</p>${active?'<button data-action="stop-tunnel">연결 중지</button>':''}</div></section>
  <section class="panel"><h2>3. 맞춤형 MCP 서버 만들기</h2><ol><li>웹 ChatGPT의 <strong>설정 → 보안 및 로그인</strong>에서 개발자 모드를 켭니다.</li><li>아래 버튼으로 플러그인 페이지를 열고 <strong>+ → 맞춤형 MCP 서버 만들기</strong>를 선택합니다. 이름은 <strong>WWG</strong>, 설명은 <strong>내 컴퓨터의 파일·명령 실행</strong>으로 입력합니다.</li><li><strong>Connection → Tunnel</strong>을 선택하고, WWG에서 연결한 터널을 선택하거나 복사한 터널 ID를 입력합니다.</li><li>왼쪽에 <strong>터널 연결됨</strong>이 표시되면 웹에서 생성을 완료하고 WWG의 도구 목록을 확인합니다.</li></ol><div class="buttons column"><button class="primary" data-link="plugins">맞춤형 MCP 서버 만들기 ↗</button><button data-action="copy-tunnel" ${!tunnel.tunnelId?'disabled':''}>터널 ID 복사</button></div><p class="note">맞춤형 MCP 서버 생성 화면은 먼저 열어 둘 수 있습니다. 생성을 완료할 때는 WWG의 터널이 연결되어 있어야 합니다.</p>
  <h2>4. @WWG로 플러그인 활성화</h2><ol><li>웹 ChatGPT 대화에서 <strong>@WWG</strong>를 입력하고 WWG 플러그인을 선택해 활성화합니다.</li><li>원하는 파일·명령 작업을 요청합니다. 실행 결과와 필요한 승인은 WWG에서 확인합니다.</li></ol><p class="note">대화 중에는 WWG와 터널 연결을 유지하세요. WWG 플러그인 활성화 여부는 웹 ChatGPT에서 확인합니다.</p></section></div>`;
}
function settingsView():string {
  return `<div class="section-heading"><div><h1>접근 설정</h1><p>사용할 폴더와 환경변수 이름만 지정합니다.</p></div></div><section class="panel settings-panel"><div class="panel-heading"><h2>접근 폴더</h2><button data-action="select-folders">+ 폴더 선택</button></div><p>여러 폴더를 한 번에 선택할 수 있습니다. 선택한 폴더 안에서도 .env와 비밀파일은 차단됩니다.</p><div class="folder-scopes">${data.folders.map(folder=>`<div><code>${folder.approvedFolders.map(relative=>escape(relative?folder.path+(data.runtime?.platform==='win32'?'\\':'/')+relative:folder.path)).join('<br>')}</code><button data-remove-folder="${folder.id}">접근 해제</button></div>`).join('')||'<p>허용한 폴더가 없습니다.</p>'}</div><p class="note">접근을 해제하면 대기·실행 중인 요청을 중지합니다. 실제 폴더와 파일은 삭제하지 않습니다.</p></section><section class="panel settings-panel"><h2>OS 환경변수</h2><p>명령에 사용할 기존 환경변수의 이름만 허용합니다. .env 파일을 불러오는 기능은 없습니다.</p><form id="environment-form"><label for="environment-names">허용할 이름</label><div class="environment-input"><input id="environment-names" name="names" value="${escape(data.environmentNames.join(', '))}" placeholder="API_TOKEN, DATABASE_URL" spellcheck="false" autocomplete="off"><button type="submit">저장</button></div></form><p class="note">명령에서 요청한 허용 변수만 전달합니다. 이름만 저장하며 값은 실행 출력에서 숨깁니다.</p></section>${data.approvalMode==='automatic'?`<section class="panel settings-panel"><h2>자동승인</h2><p>${data.rememberAutomatic?'다음 실행에도 자동승인을 유지합니다.':'자동승인은 이번 실행에만 적용됩니다.'}</p><button data-action="automatic-options">유지 설정 변경</button></section>`:''}`;
}
function render():void {
  if(!data)return;
  const inputs=[...root.querySelectorAll<HTMLInputElement>('form input')], focused=document.activeElement;
  const scroll=root.querySelector('.content')?.scrollTop??0;
  const pending=data.jobs.filter(job=>job.state==='pending').length, automatic=data.approvalMode==='automatic';
  const status=data.paused?'일시 정지':tunnel.phase==='ready'?'터널 연결됨':'연결 전';
  root.innerHTML=`<header class="topbar"><div class="brand">WWG<small>workwebGPT</small></div><nav aria-label="메인 메뉴"><button data-tab="logs" aria-current="${tab==='logs'?'page':'false'}">실행 로그${pending?`<b>${pending}</b>`:''}</button><button data-tab="connect" aria-current="${tab==='connect'?'page':'false'}">ChatGPT 연결</button><button data-tab="settings" aria-current="${tab==='settings'?'page':'false'}">접근 설정</button></nav><div class="top-actions"><button data-action="pause">${data.paused?'▶ 재개':'Ⅱ 일시 정지'}</button></div></header><div class="controls"><span class="connection"><i class="dot ${tunnel.phase==='ready'&&!data.paused?'on':''}"></i>${status}</span><span class="mode">${automatic?'자동승인':'수동승인'}</span><button data-action="automatic" ${data.paused?'disabled':''}>${automatic?'자동승인 끄기':'자동승인 켜기'}</button><button class="folder-button" data-action="select-folders">접근 폴더 ${data.folders.length}개 · 선택</button><span class="secret-policy">.env 읽기 차단</span></div>${data.error?`<div class="banner error" role="alert">${escape(data.error)}</div>`:''}${data.paused?'<div class="banner">요청 수신과 실행이 일시 정지되었습니다. 실행 중인 요청은 중지합니다.</div>':''}${!data.folders.length?'<div class="banner">파일 작업을 시작하려면 상단의 접근 폴더를 선택하세요. 여러 폴더를 선택할 수 있습니다.</div>':''}<main class="content">${tab==='connect'?connectionView():tab==='settings'?settingsView():logsView()}</main><footer><span>${data.connected?'로컬 연결 준비됨':'로컬 연결 오류'}</span><span>WWG ${escape(data.version)}</span></footer>`;
  for(const input of inputs){const replacement=root.querySelector<HTMLInputElement>('#'+input.id);if(replacement){input.disabled=replacement.disabled;replacement.replaceWith(input);if(input===focused)input.focus({preventScroll:true});}}
  const content=root.querySelector('.content');if(content)content.scrollTop=scroll;
}
root.addEventListener('click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button||button.disabled)return;
  if(button.dataset.tab){navigate(button.dataset.tab as NavigationTarget['tab']);return;}
  if(button.dataset.filter){onlyPending=button.dataset.filter==='pending';limit=40;render();return;}
  if(button.dataset.approve){void action(()=>api.decide(button.dataset.approve!,true));return;}
  if(button.dataset.decline){void action(()=>api.decide(button.dataset.decline!,false));return;}
  if(button.dataset.cancel){void action(()=>api.cancelJob(button.dataset.cancel!));return;}
  if(button.dataset.cancelTask){void action(()=>api.cancelTask(button.dataset.cancelTask!));return;}
  if(button.dataset.removeFolder){void action(()=>api.removeFolder(button.dataset.removeFolder!));return;}
  if(button.dataset.link){void action(()=>api.openConnectionLink(button.dataset.link as ConnectionLink));return;}
  switch(button.dataset.action){
    case 'select-folders':void action(()=>api.selectFolders());break;
    case 'automatic':void action(()=>data.approvalMode==='automatic'?api.stopAutomatic():api.startAutomatic());break;
    case 'automatic-options':void action(()=>api.startAutomatic());break;
    case 'pause':void action(()=>api.pause(!data.paused));break;
    case 'clear-logs':void action(()=>api.clearLogs());break;
    case 'more':limit+=40;render();break;
    case 'copy-tunnel':void action(async()=>{await api.copyTunnelId();toast('터널 ID를 복사했습니다.');});break;

    case 'inspect':void action(()=>api.inspectTunnel());break;
    case 'stop-tunnel':void action(()=>api.stopTunnel());break;
  }
});
root.addEventListener('submit',event=>{
  const form=event.target as HTMLFormElement;event.preventDefault();
  if(form.id==='environment-form'){
    const names=String(new FormData(form).get('names')??'').split(/[\s,]+/).filter(Boolean);
    void action(()=>api.setEnvironmentNames(names));
  }else if(form.id==='tunnel-form'&&!tunnelBusy){
    const fields=new FormData(form), id=String(fields.get('tunnelId')??'').trim(), key=String(fields.get('apiKey')??'').trim();
    form.querySelector<HTMLInputElement>('#tunnel-key')!.value='';tunnelBusy=true;render();
    void(async()=>{try{await api.startTunnel(id,key);}catch(error){toast((error as Error).message);}finally{tunnelBusy=false;await refresh().catch(error=>toast(error.message));}})();
  }
});
root.addEventListener('toggle',event=>{const node=event.target as HTMLDetailsElement;if(node.dataset.detail){if(node.open)details.add(node.dataset.detail);else details.delete(node.dataset.detail);}if(node.dataset.task){if(node.open)collapsedTasks.delete(node.dataset.task);else collapsedTasks.add(node.dataset.task);}},true);
api.onChange(()=>{void refresh().catch(error=>toast(error.message));});
api.onNavigate(target=>{if(data)navigate(target.tab);else{tab=target.tab;initialized=true;}});
root.innerHTML='<div class="loading">WWG 연결을 확인하고 있습니다…</div>';
void refresh().catch(error=>{root.innerHTML='<div class="loading">WWG를 불러오지 못했습니다. 앱을 다시 실행하세요.</div>';toast(error.message);});
