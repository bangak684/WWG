import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { Store } from './store';
import * as files from './files';
import { APP_VERSION, type ApprovalMode, type Job, type Project, type Snapshot, type FolderScope, type Receipt, type Task, type TaskSnapshot } from '../shared';
import { applyEdits, fingerprint, terminal, type Proposal } from './request';
import { commandSandbox, inspectCommandTree } from './command-sandbox';
import { commandEnvironment, outputRedactor, selectedEnvironment, validateEnvironmentNames } from './command-environment';
import { requireSafeRoot } from './secret-policy';
import { emptyTaskCounts, taskState } from './tasks';
export { commandEnvironment } from './command-environment';

interface Runtime { process: ChildProcess; output: string; bytes: number; cancelled: boolean; reason: string; killTimer?: NodeJS.Timeout }
const MAX_OUTPUT = 32000;
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

export class Workspace extends EventEmitter {
  paused = false; lastCall: number | null = null; endpoint: string | null = null; error: string | null = null;
  private active = new Map<string, Promise<void>>();
  private activeProjects = new Set<string>();
  private cancellations = new Set<string>();
  private revoked = new Set<string>();
  private processes = new Map<string, Runtime>();
  private proposalQueue: Promise<unknown> = Promise.resolve();
  private incoming = 0;
  private closing = false;
  private shutdownPromise?: Promise<void>;
  private outputTimer?: NodeJS.Timeout;
  private waiters = new Set<() => void>();
  constructor(public store: Store, public dataDir: string, private protectedPaths: string[] = []) {
    super();
    store.on('warning', (message: string) => this.failClosed(message));
    store.on('change', () => this.changed());
  }
  changed(): void { for (const wake of this.waiters) wake(); this.emit('change'); }
  /** Holds a tool response while automatic work runs, so fast jobs return their final state in one call. */
  async settle(id: string, ms: number): Promise<Job> {
    const active = (): boolean => { const state = this.job(id).state; return state === 'queued' || state === 'running'; };
    if (ms > 0 && !this.closing && active()) await new Promise<void>(resolve => {
      const done = (): void => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
      const wake = (): void => { try { if (this.closing || !active()) done(); } catch { done(); } };
      const timer = setTimeout(done, ms); timer.unref();
      this.waiters.add(wake);
    });
    return this.jobSnapshot(id);
  }
  private outputChanged(): void {
    if (this.closing) return;
    if (!this.outputTimer) this.outputTimer = setTimeout(() => { this.outputTimer = undefined; this.changed(); }, 100);
  }
  private failClosed(message: string): void {
    this.error = message; this.paused = true;
    for (const job of this.store.data.jobs) if (!terminal(job.state)) this.cancellations.add(job.id);
    for (const id of this.processes.keys()) this.kill(id, '저장 오류로 실행을 중지했습니다.');
    this.changed();
  }
  snapshot(): Snapshot {
    const settings = this.store.data.settings;
    return { folders: structuredClone(this.store.data.folders), ...settings, jobs: this.store.data.jobs.map(j => this.jobSnapshot(j.id)), tasks: this.taskSnapshots(), connected: !!this.endpoint, paused: this.paused, lastCall: this.lastCall, endpoint: null, error: this.error, version: APP_VERSION };
  }
  private task(id: string): Task {
    const task = this.store.data.tasks.find(task => task.id === id);
    if (!task) throw new Error('작업을 찾을 수 없습니다. tasks_list로 확인하거나 새 작업을 만드세요.');
    return task;
  }
  private requireTaskAvailable(id?: string): void {
    if (id && this.task(id).cancelledAt !== undefined) throw new Error('중지한 작업에는 요청을 추가할 수 없습니다. 새 작업을 만드세요.');
  }
  taskSnapshot(id: string): TaskSnapshot {
    const task = structuredClone(this.task(id));
    return { ...task, state:taskState(task), totalRequests:Object.values(task.counts).reduce((sum,count)=>sum+count,0), retainedRequests:this.store.data.jobs.filter(job=>job.taskId===id).length };
  }
  taskSnapshots(): TaskSnapshot[] { return this.store.data.tasks.map(task=>this.taskSnapshot(task.id)).sort((a,b)=>b.updatedAt-a.updatedAt); }
  async createTask(requestId: string, title: string, resumeFrom?: string): Promise<TaskSnapshot> {
    if (this.paused || this.closing) throw new Error('WWG 연결이 일시 정지되어 있습니다.');
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 200 || /[\x00-\x1f\x7f]/.test(trimmed)) throw new Error('작업 이름은 1~200자의 한 줄로 지정하세요.');
    await this.store.update(d => {
      if (this.paused || this.closing) throw new Error('WWG 연결이 일시 정지되어 있습니다.');
      const existing = d.tasks.find(task=>task.id===requestId);
      if (existing) { if (existing.title !== trimmed || existing.resumedFrom !== resumeFrom) throw new Error('이미 사용한 requestId입니다. 다른 작업에는 새 UUID를 사용하세요.'); return; }
      if (d.receipts.some(receipt=>receipt.taskId===requestId)) throw new Error('정리된 작업의 requestId입니다. 새 UUID로 작업을 만드세요.');
      if (d.tasks.length >= 100) throw new Error('작업은 최대 100개입니다. 완료 로그를 비운 뒤 새 작업을 만드세요.');
      const source=resumeFrom?d.tasks.find(task=>task.id===resumeFrom):undefined;
      if (resumeFrom && !source) throw new Error('이어갈 이전 작업을 찾을 수 없습니다.');
      const now=Date.now(); d.tasks.unshift({id:requestId,title:trimmed,counts:emptyTaskCounts(),memory:source?structuredClone(source.memory):[],createdAt:now,updatedAt:now,resumedFrom:resumeFrom,checkpoint:source?.checkpoint?structuredClone(source.checkpoint):undefined});
    });
    return this.taskSnapshot(requestId);
  }
  async checkpointTask(id: string, summary: string, nextSteps: string[]): Promise<TaskSnapshot> {
    this.task(id);
    await this.store.update(d=>{
      const task=d.tasks.find(task=>task.id===id); if(!task)throw new Error('작업을 찾을 수 없습니다.');
      const now=Date.now(); task.checkpoint={summary,nextSteps:[...nextSteps],updatedAt:now};task.updatedAt=now;
      d.tasks.unshift(d.tasks.splice(d.tasks.indexOf(task),1)[0]!);
    });
    return this.taskSnapshot(id);
  }
  recallTask(id?: string): TaskSnapshot {
    const selected=id??this.taskSnapshots().find(task=>task.totalRequests>0||task.checkpoint||task.memory.length)?.id;
    if(!selected)throw new Error('저장된 작업 기억이 없습니다.');
    return this.taskSnapshot(selected);
  }
  async cancelTask(id: string): Promise<TaskSnapshot> {
    this.task(id);
    await this.store.update(d=>{const task=d.tasks.find(task=>task.id===id)!;task.cancelledAt??=Date.now();task.updatedAt=Date.now();});
    const ids=this.store.data.jobs.filter(job=>job.taskId===id&&!terminal(job.state)).map(job=>job.id);
    for (const jobId of ids) this.cancellations.add(jobId);
    for (const jobId of ids) await this.cancel(jobId);
    return this.taskSnapshot(id);
  }
  private insertLog(d: Store['data'], job: Job): void {
    if (d.jobs.length >= 200) {
      const index=d.jobs.findLastIndex(job=>terminal(job.state));
      if (index<0) throw new Error('대기·실행 요청이 200개입니다. 일부를 완료하거나 취소하세요.');
      d.jobs.splice(index,1);
    }
    d.jobs.unshift(job);
  }
  async beginTaskRead(taskId: string, tool: string, label: string): Promise<string> {
    const now=Date.now(), id=randomUUID();
    await this.store.update(d=>{
      this.requireTaskAvailable(taskId);
      if (this.paused || this.closing) throw new Error('WWG 연결이 일시 정지되어 있습니다.');
      this.insertLog(d,{id,requestId:id,projectId:'00000000-0000-4000-8000-000000000000',taskId,kind:'read',tool,label:label.slice(0,8000),state:'running',output:'',createdAt:now,updatedAt:now});
    });
    return id;
  }
  checkTaskRead(id: string): void {
    const job=this.job(id);
    this.requireTaskAvailable(job.taskId);
    if (this.cancellations.has(id) || this.paused || this.closing) throw new Error('조회 중 작업 또는 연결이 중지되었습니다.');
  }
  async finishTaskRead(id: string, ok: boolean, output: string): Promise<void> {
    const job=this.job(id), cancelled=this.cancellations.has(id)||this.paused||this.closing||this.task(job.taskId!).cancelledAt!==undefined;
    await this.finish(id,cancelled?'cancelled':ok?'done':'failed',output);
    this.cancellations.delete(id);
  }
  jobSnapshot(id: string): Job { const job = this.job(id); return { ...job, output: this.processes.get(id)?.output ?? job.output }; }
  project(id: string): Project {
    const folder = this.store.data.folders.find(folder => folder.id === id);
    if (!folder) throw new Error('접근이 허용되지 않은 폴더입니다.');
    return { ...folder, writable: true, approvalMode: this.store.data.settings.approvalMode, environmentNames: this.store.data.settings.environmentNames };
  }
  resolveAbsolute(value: string): { project: Project; relative: string } {
    if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('파일 또는 실행 폴더의 전체 경로를 지정하세요.');
    const target = path.resolve(value);
    const compare = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
    const folder = [...this.store.data.folders].sort((a,b) => b.path.length-a.path.length).find(folder => {
      const relative = path.relative(folder.path,target).split(path.sep).join('/');
      return (compare(target) === compare(folder.path) || compare(target).startsWith(compare(folder.path + path.sep))) && files.approved(this.project(folder.id),relative);
    });
    if (!folder) throw new Error('허용되지 않는 경로입니다. WWG에서 접근 폴더를 선택하세요. 비밀파일은 항상 차단됩니다.');
    return { project: this.project(folder.id), relative: path.relative(folder.path,target).split(path.sep).join('/') };
  }
  job(id: string): Job {
    const job = this.store.data.jobs.find(j => j.id === id);
    if (job) return job;
    const receipt = this.store.data.receipts.find(r => r.id === id);
    if (receipt) return this.receiptJob(receipt);
    throw new Error('작업 요청을 찾을 수 없습니다.');
  }
  private receiptJob(r: Receipt): Job { return { ...r, label: '정리된 실행 기록', output: '이 요청은 이미 처리되었습니다. 원문·출력 기록은 정리되어 재실행하지 않습니다.' }; }
  private requireWritable(id: string): void {
    if (this.paused || this.closing) throw new Error('WWG 연결이 일시 정지되어 있습니다.');
    if (this.revoked.has(id) || !this.project(id).writable) throw new Error('실행 폴더 권한이 변경되었습니다. 다시 요청하세요.');
  }
  private allowed(job: Job): boolean {
    return !this.paused && !this.closing && !this.revoked.has(job.projectId) && !this.cancellations.has(job.id) && (!job.taskId || this.task(job.taskId).cancelledAt === undefined) && !!this.store.data.folders.find(folder => folder.id === job.projectId);
  }
  async addFolders(paths: string[]): Promise<void> {
    const folders: FolderScope[] = [];
    const privateRoot = await fs.realpath(this.dataDir).catch(() => path.resolve(this.dataDir));
    const home = await fs.realpath(os.homedir());
    for (const folder of paths) {
      requireSafeRoot(folder);
      const canonical = await fs.realpath(folder); requireSafeRoot(canonical);
      if (!(await fs.stat(canonical)).isDirectory()) throw new Error('폴더를 선택하세요.');
      if (canonical === path.parse(canonical).root || canonical === home || overlaps(canonical,privateRoot) || this.protectedPaths.some(p => overlaps(canonical,path.resolve(p)))) throw new Error('홈·시스템 루트·앱 데이터 대신 사용할 하위 폴더를 선택하세요.');
      if (!folders.some(folder => folder.path === canonical)) folders.push({id:randomUUID(),path:canonical,approvedFolders:['']});
    }
    await this.store.update(d => {
      for (const folder of folders) {
        const existing = d.folders.find(existing => existing.path === folder.path);
        if (existing) existing.approvedFolders = ['']; else d.folders.push(folder);
      }
      if (d.folders.length > 100) throw new Error('접근 폴더는 최대 100개입니다.');
    });
    this.changed();
  }
  async removeFolder(id: string): Promise<void> {
    this.project(id); const ids = this.store.data.folders.map(folder => folder.id); for (const scope of ids) this.revoked.add(scope);
    try {
      await this.cancelProject(); await this.waitForIdle();
      await this.store.update(d => { d.folders = d.folders.filter(folder => folder.id !== id); if (!d.folders.length) { d.settings.approvalMode = 'review'; d.settings.rememberAutomatic = false; } });
    } finally { for (const scope of ids) this.revoked.delete(scope); this.changed(); }
  }
  async enableAutomatic(remember: boolean, expectedFolders: FolderScope[]): Promise<void> {
    const expected = JSON.stringify(expectedFolders);
    const check = (): void => {
      if (JSON.stringify(this.store.data.folders) !== expected || !this.store.data.folders.length) throw new Error('접근 폴더가 변경되었습니다. 자동승인을 다시 시작하세요.');
      if (this.paused || this.closing) throw new Error('연결을 재개한 뒤 자동승인을 시작하세요.');
    };
    check();
    for (const folder of expectedFolders) for (const relative of folder.approvedFolders) {
      const target = await files.resolveFile(this.project(folder.id),relative);
      if (!(await fs.lstat(target)).isDirectory()) throw new Error('접근 폴더를 다시 선택하세요.');
    }
    if (this.store.data.settings.approvalMode === 'automatic') {
      await this.store.update(d => { check(); d.settings.rememberAutomatic = remember; });
      this.changed(); return;
    }
    for (const folder of expectedFolders) this.revoked.add(folder.id);
    try {
      await this.cancelProject(undefined,true); await this.waitForIdle();
      await this.store.update(d => {
        check(); d.settings.approvalMode = 'automatic'; d.settings.rememberAutomatic = remember;
        for (const job of d.jobs) if (job.state === 'pending' && d.folders.some(folder => folder.id === job.projectId)) {
          job.state = 'queued'; job.approval = 'automatic'; job.updatedAt = Date.now();
          const receipt = d.receipts.find(receipt => receipt.id === job.id); if (receipt) { receipt.state = job.state; receipt.updatedAt = job.updatedAt; }
        }
      });
    } finally { for (const folder of expectedFolders) this.revoked.delete(folder.id); this.changed(); this.pump(); }
  }
  async disableAutomatic(): Promise<void> {
    const ids = this.store.data.folders.map(folder => folder.id); for (const id of ids) this.revoked.add(id);
    try {
      await this.cancelProject(); await this.waitForIdle();
      await this.store.update(d => { d.settings.approvalMode = 'review'; d.settings.rememberAutomatic = false; });
    } finally { for (const id of ids) this.revoked.delete(id); this.changed(); }
  }
  async setEnvironmentNames(raw: unknown): Promise<void> {
    const names = validateEnvironmentNames(raw), ids = this.store.data.folders.map(folder => folder.id);
    for (const id of ids) this.revoked.add(id);
    try {
      await this.cancelProject(); await this.waitForIdle();
      await this.store.update(d => { d.settings.environmentNames = names; });
    } finally { for (const id of ids) this.revoked.delete(id); this.changed(); }
  }
  async clearLogs(): Promise<void> {
    await this.store.flushLazy(); await this.store.update(d => {
      d.jobs = d.jobs.filter(job => !terminal(job.state));
      d.tasks = d.tasks.filter(task=>['waiting','pending','queued','running','stopping'].includes(taskState(task)));
    });
    this.changed();
  }
  propose(input: Proposal): Promise<Job> {
    if (this.incoming >= 32) return Promise.reject(new Error('요청이 많습니다. 실행 결과를 확인한 뒤 다시 시도하세요.'));
    const copy = { ...input, ...(input.environment ? { environment: [...input.environment] } : {}) }; this.incoming++;
    const work = this.proposalQueue.then(() => this.accept(copy));
    this.proposalQueue = work.then(() => {}, () => {});
    return work.finally(() => { this.incoming--; });
  }
  private retry(requestId: string, requestHash: string): Job | undefined {
    const receipt = this.store.data.receipts.find(r => r.requestId === requestId);
    if (!receipt) return undefined;
    if (!receipt.requestHash) throw new Error('이전 버전의 requestId입니다. 실제 결과를 확인하세요. 자동 재실행하지 않습니다.');
    if (receipt.requestHash !== requestHash) throw new Error('이미 사용한 requestId입니다. 다른 요청에는 새 UUID를 사용하세요.');
    return this.jobSnapshot(receipt.id);
  }
  private async accept(input: Proposal): Promise<Job> {
    this.project(input.projectId);
    // Identity is the caller's request; a patch's derived content depends on the file and is excluded.
    const requestHash = fingerprint(input);
    const previous = this.retry(input.requestId, requestHash); if (previous) return previous;
    this.requireTaskAvailable(input.taskId);
    this.requireWritable(input.projectId);
    if (!['write','delete','command'].includes(input.kind)) throw new Error('지원하지 않는 요청입니다.');
    if (input.kind === 'command' && (!input.command || input.command.length > 8000 || input.command.includes('\0'))) throw new Error('명령 형식이 올바르지 않습니다.');
    if (input.kind === 'delete' && !/^[a-f0-9]{64}$/.test(input.expectedHash ?? '')) throw new Error('삭제할 파일의 현재 SHA-256 해시가 필요합니다.');
    const { edits, ...request } = input;
    if (request.kind === 'write' && !edits) files.validateContent(request.content!);
    if (request.kind !== 'command') files.requireApproved(this.project(request.projectId), request.path!);
    const before = request.kind === 'write' ? await files.checkRevision(this.project(request.projectId), request.path!, request.expectedHash ?? null) : undefined;
    if (request.kind === 'delete') await files.checkRevision(this.project(request.projectId), request.path!, request.expectedHash!);
    if (edits) { request.content = applyEdits(before!, edits); files.validateContent(request.content); }
    this.requireWritable(request.projectId);
    const mode = this.project(request.projectId).approvalMode ?? 'review';
    if (request.kind === 'command') {
      const project = this.project(request.projectId);
      files.requireApproved(project,request.path ?? '');
      if (!(await fs.lstat(await files.resolveFile(project,request.path ?? ''))).isDirectory()) throw new Error('명령의 실행 폴더를 지정하세요.');
      commandSandbox(project);
      selectedEnvironment(this.project(request.projectId).environmentNames ?? [], request.environment ?? []);
    }
    const automatic = mode === 'automatic';
    const now = Date.now();
    const job: Job = { ...request, id: randomUUID(), requestHash, approval: automatic ? 'automatic' : 'manual', label: (request.kind === 'command' ? request.command! : path.join(this.project(request.projectId).path,request.path!)).slice(0,8000), directory: request.kind === 'command' ? path.resolve(this.project(request.projectId).path,request.path ?? '') : this.project(request.projectId).path, state: automatic ? 'queued' : 'pending', before, output: '', createdAt: now, updatedAt: now };
    await this.store.update(d => {
      this.requireWritable(input.projectId);
      this.requireTaskAvailable(input.taskId);
      const currentMode = this.project(input.projectId).approvalMode ?? 'review';
      const currentlyAutomatic = currentMode === 'automatic';
      job.approval = currentlyAutomatic ? 'automatic' : 'manual'; job.state = currentlyAutomatic ? 'queued' : 'pending';
      if (d.receipts.length >= 10000) {
        // Forget the oldest settled request older than a day. Listed jobs keep their receipts,
        // so a restart never has to recreate one past the cap; recent retries stay idempotent.
        const listed = new Set(d.jobs.map(j => j.id));
        const index = d.receipts.findIndex(r => terminal(r.state) && r.updatedAt < now - 86400000 && !listed.has(r.id));
        if (index < 0) throw new Error('최근 24시간의 중복 실행 방지 기록이 10,000개입니다. 잠시 후 다시 시도하세요.');
        d.receipts.splice(index, 1);
      }
      this.insertLog(d,job);
      d.receipts.push({ id: job.id, requestId: job.requestId, projectId: job.projectId, taskId:job.taskId, requestHash: job.requestHash, kind: job.kind, state: job.state, createdAt: now, updatedAt: now });
    });
    this.changed(); this.pump(); return this.jobSnapshot(job.id);
  }
  async decide(id: string, accept: boolean): Promise<void> {
    const job = this.job(id);
    if (job.state !== 'pending') throw new Error('이미 처리된 요청입니다.');
    if (!accept) { await this.finish(id, 'declined', '사용자가 거절했습니다.'); return; }
    this.requireWritable(job.projectId);
    await this.store.update(d => { this.requireTaskAvailable(job.taskId); const j = d.jobs.find(j => j.id === id)!; if (j.state !== 'pending') throw new Error('이미 처리된 요청입니다.'); j.state = 'queued'; j.updatedAt = Date.now(); });
    this.changed(); this.pump();
  }
  private pump(): void {
    if (this.paused || this.closing) return;
    for (const job of [...this.store.data.jobs].reverse()) {
      if (this.active.size >= 2) break;
      if (job.state !== 'queued' || this.active.has(job.id)) continue;
      // A command can touch every granted folder, so it owns all execution scopes.
      if (job.kind === 'command' && this.active.size) break;
      if ([...this.active.keys()].some(id => this.job(id).kind === 'command') || [...this.activeProjects].some(id => overlaps(this.project(id).path,this.project(job.projectId).path))) continue;
      this.activeProjects.add(job.projectId);
      const run = Promise.resolve().then(() => this.execute(job.id)).catch(() => {
        this.failClosed('작업 기록을 확정하지 못했습니다. 실제 파일·명령 결과를 확인하고 앱을 재시작하세요.');
      }).finally(() => { this.active.delete(job.id); this.activeProjects.delete(job.projectId); this.cancellations.delete(job.id); this.changed(); this.pump(); });
      this.active.set(job.id, run);
    }
  }
  private async execute(id: string): Promise<void> {
    const job = this.job(id);
    if (terminal(job.state)) return;
    if (!this.allowed(job)) { await this.finish(id, 'cancelled', '실행 전에 권한 또는 연결이 취소되었습니다.'); return; }
    await this.store.update(d => {
      const j = d.jobs.find(j => j.id === id)!;
      if (j.state !== 'queued') return;
      j.state = 'running'; j.updatedAt = Date.now();
      d.receipts.find(r => r.id === id)!.state = 'running';
    });
    this.changed();
    if (!this.allowed(job) || this.job(id).state !== 'running') { await this.finish(id, 'cancelled', '실행 전에 권한이 취소되었습니다.'); return; }
    let result: { state: Job['state']; output: string; code?: number | null; resultHash?: string };
    try {
      if (job.kind === 'write') {
        await files.writeFile(this.project(job.projectId), job.path!, job.content!, job.expectedHash ?? null, () => this.allowed(job) && files.approved(this.project(job.projectId), job.path!));
        // The saved text's revision lets the caller chain the next edit without re-reading.
        result = { state: 'done', output: '파일을 저장했습니다.', resultHash: files.hash(job.content!) };
      } else if (job.kind === 'delete') {
        await files.deleteFile(this.project(job.projectId), job.path!, job.expectedHash!, () => this.allowed(job) && files.approved(this.project(job.projectId), job.path!));
        result = { state: 'done', output: '파일을 삭제했습니다.' };
      } else if (job.kind === 'command') result = await this.runCommand(job);
      else throw new Error('지원하지 않는 실행 요청입니다.');
    } catch (err) { result = { state: this.allowed(job) ? 'failed' : 'cancelled', output: (err as Error).message }; }
    // Do not convert persistence failure after a side effect into a claim that it never happened.
    await this.finish(id, result.state, result.output, result.code, result.resultHash);
  }
  private async runCommand(job: Job): Promise<{ state: Job['state']; output: string; code?: number | null }> {
    const project = this.project(job.projectId);
    files.requireApproved(project,job.path ?? '');
    const cwd = await files.resolveFile(project,job.path ?? '');
    if (!(await fs.lstat(cwd)).isDirectory()) throw new Error('명령의 실행 폴더가 변경되었습니다.');
    if (!this.allowed(job)) throw new Error('실행 전에 변경 권한이 취소되었습니다.');
    commandSandbox(project); // Fail closed on platforms without the mandatory sandbox.
    for (const folder of project.approvedFolders ?? []) {
      const target = await files.resolveFile(project, folder);
      if (!(await fs.lstat(target)).isDirectory()) throw new Error('승인 폴더가 변경되었습니다. 다시 승인하세요.');
    }
    const others = this.store.data.folders.filter(folder => folder.id !== project.id).map(folder => this.project(folder.id));
    for (const scope of others) for (const folder of scope.approvedFolders) {
      if (!(await fs.lstat(await files.resolveFile(scope,folder))).isDirectory()) throw new Error('접근 폴더가 변경되었습니다.');
    }
    const inspected = await inspectCommandTree(project, () => this.allowed(job),others);
    const sandbox = commandSandbox(project, true, [...inspected.targets, this.dataDir, ...this.protectedPaths], inspected.protectedParents,others);
    if (!this.allowed(job)) throw new Error('실행 전에 변경 권한이 취소되었습니다.');
    const selected = selectedEnvironment(this.project(job.projectId).environmentNames ?? [], job.environment ?? []);
    const redact = outputRedactor(Object.values(selected));
    const child = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, '/bin/sh', '-c', job.command!], { cwd, env: commandEnvironment(selected), detached: true, shell: false, stdio: ['ignore','pipe','pipe'] });
    const runtime: Runtime = { process: child, output: '', bytes: 0, cancelled: false, reason: '' };
    this.processes.set(job.id, runtime);
    const collect = (text: string): void => { runtime.output = (runtime.output + text).slice(-MAX_OUTPUT); this.outputChanged(); };
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    [child.stdout, child.stderr].forEach((stream, i) => stream?.on('data', (buffer: Buffer) => {
      runtime.bytes += buffer.length; collect(redact(decoders[i]!.write(buffer)));
      if (job.approval !== 'automatic' && runtime.bytes > 2 * 1024 * 1024 && !runtime.cancelled) this.kill(job.id, '총 출력 2MB 한도로 실행을 중지했습니다.');
    }));
    const timer = job.approval === 'automatic' ? undefined : setTimeout(() => this.kill(job.id, '120초 실행 한도에 도달했습니다.'), 120000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      for (const decoder of decoders) collect(redact(decoder.end()));
      collect(redact('', true));
      return { state: runtime.cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed', output: (runtime.output + (runtime.reason ? '\n[' + runtime.reason + ']' : '')).slice(-MAX_OUTPUT) || '(출력 없음)', code };
    } finally {
      if (timer) clearTimeout(timer);
      // Parent exit is not proof that descendants exited. Do not leave a live process group behind.
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      if (runtime.killTimer) clearTimeout(runtime.killTimer);
      this.processes.delete(job.id);
    }
  }
  private kill(id: string, reason = '사용자가 실행을 중지했습니다.'): void {
    const runtime = this.processes.get(id); if (!runtime || runtime.cancelled) return;
    runtime.cancelled = true; runtime.reason = reason;
    if (process.platform === 'win32' && runtime.process.pid) {
      const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      const killer = spawn(taskkill, ['/PID', String(runtime.process.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { runtime.process.kill(); } catch {} });
      killer.on('close', code => { if (code !== 0) try { runtime.process.kill(); } catch {} });
      return;
    }
    const signal = (value: NodeJS.Signals): void => { try { if (process.platform !== 'win32' && runtime.process.pid) process.kill(-runtime.process.pid, value); else runtime.process.kill(value); } catch {} };
    signal('SIGTERM'); runtime.killTimer = setTimeout(() => signal('SIGKILL'), 1000); runtime.killTimer.unref();
  }
  async cancel(id: string): Promise<void> {
    const job = this.job(id); if (terminal(job.state)) return;
    this.cancellations.add(id); this.kill(id);
    if (job.state === 'pending' || job.state === 'queued') await this.finish(id, 'cancelled', '사용자가 취소했습니다.');
    this.changed();
  }
  private async cancelProject(projectId?: string, preservePending = false): Promise<void> {
    const ids = this.store.data.jobs.filter(j => (!projectId || j.projectId === projectId) && !terminal(j.state) && !(preservePending && j.state === 'pending')).map(j => j.id);
    for (const id of ids) { this.cancellations.add(id); this.kill(id, '접근 폴더 권한 또는 연결이 변경되었습니다.'); }
    await this.store.update(d => {
      for (const j of d.jobs) if (ids.includes(j.id) && (j.state === 'pending' || j.state === 'queued')) {
        j.state = 'cancelled'; j.output = '실행 전에 취소되었습니다.'; j.updatedAt = Date.now(); delete j.content; delete j.before;
        const receipt = d.receipts.find(r => r.id === j.id); if (receipt) { receipt.state = j.state; receipt.updatedAt = j.updatedAt; }
      }
    });
  }
  async setPaused(value: boolean): Promise<void> {
    if (this.closing && !value) throw new Error('앱이 종료 중입니다.');
    this.paused = value;
    if (value) await this.cancelProject();
    else { await this.store.flushLazy(); this.error = null; }
    this.changed(); this.pump();
  }
  private async finish(id: string, state: Job['state'], output: string, code?: number | null, resultHash?: string): Promise<void> {
    await this.store.update(d => {
      const j = d.jobs.find(j => j.id === id); if (!j || terminal(j.state)) return;
      j.state = state; j.output = output.slice(-MAX_OUTPUT); j.exitCode = code; j.updatedAt = Date.now();
      if (resultHash) j.resultHash = resultHash;
      if (terminal(state)) { delete j.before; delete j.content; }
      const r = d.receipts.find(r => r.id === id); if (r) { r.state = state; r.updatedAt = j.updatedAt; }
    }); this.changed();
  }
  audit(tool: string, ok: boolean, label: string, output: string, hasJob = false, taskId?: string): void {
    if (this.closing) return;
    this.lastCall = Date.now();
    if (!hasJob && !['wwg_status','job_get','logs_list','task_create','tasks_list','task_get','task_cancel','task_checkpoint','task_recall'].includes(tool)) {
      const now = this.lastCall, id = randomUUID();
      const attached=taskId&&this.store.data.tasks.some(task=>task.id===taskId&&task.cancelledAt===undefined)?taskId:undefined;
      const job: Job = { id, requestId:id, projectId:'00000000-0000-4000-8000-000000000000', taskId:attached, kind: ['projects_list','folders_list','files_list','file_read','files_read_batch'].includes(tool) ? 'read' : 'request', tool, label:label.slice(0,8000), state:ok?'done':'failed', output:output.slice(-MAX_OUTPUT), createdAt:now, updatedAt:now };
      this.store.updateLazy(d => {
        // A task may have been cleared while this audit was waiting to be persisted.
        if (job.taskId && !d.tasks.some(task=>task.id===job.taskId)) delete job.taskId;
        this.insertLog(d,job);
      });
    }
    this.outputChanged();
  }
  async waitForIdle(): Promise<void> {
    await this.proposalQueue; this.pump();
    while (this.active.size) await Promise.allSettled([...this.active.values()]);
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true; this.paused = true;
    for (const wake of this.waiters) wake();
    if (this.outputTimer) clearTimeout(this.outputTimer);
    this.shutdownPromise = (async () => { await this.proposalQueue; await this.cancelProject(); await this.waitForIdle(); await this.store.flushLazy(); })();
    return this.shutdownPromise;
  }
}
