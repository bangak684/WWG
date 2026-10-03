import { EventEmitter } from 'node:events';
import path from 'node:path';
import { z } from 'zod';
import type { ApprovalMode, FolderScope, Job, Receipt, Task } from '../shared';
import { atomicPrivateWrite, readPrivateText } from './private-io';
import { fingerprint, terminal } from './request';
import { environmentNames } from './command-environment';
import { emptyTaskCounts, syncTaskCounts } from './tasks';
import { STORED_LOG_LIMIT } from '../shared';
import { retainHistory } from './log-retention';

export interface Data { version: 2; folders: FolderScope[]; settings: { approvalMode: ApprovalMode; environmentNames: string[]; rememberAutomatic: boolean }; jobs: Job[]; receipts: Receipt[]; tasks: Task[] }
type Mutation = (draft: Data) => void;
const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_WORKSPACE_BYTES = 256 * 1024 * 1024;
const state = z.enum(['pending', 'queued', 'running', 'done', 'failed', 'declined', 'cancelled']);
const folders = z.array(z.object({ id, path: z.string().max(8192), approvedFolders: z.array(z.string().max(1024)).max(500).default([]) })).max(100);
const jobs = z.array(z.object({
    id, requestId: id, projectId: id, taskId: id.optional(), kind: z.enum(['write','delete','command','access','read','request']), state,
    label: z.string().max(8000), path: z.string().max(1024).optional(), content: z.string().max(262144).optional(), expectedHash: digest.nullable().optional(), command: z.string().max(8000).optional(), environment: environmentNames.optional(),
    before: z.string().max(262144).optional(), requestHash: digest.optional(), resultHash: digest.optional(), approval: z.enum(['manual','automatic']).optional(),
    tool: z.string().max(128).optional(), directory: z.string().max(8192).optional(),
    output: z.string().max(64000), exitCode: z.number().nullable().optional(), createdAt: z.number(), updatedAt: z.number()
  }).refine(job => !['read','request'].includes(job.kind) || terminal(job.state) || (job.taskId && job.kind === 'read' && job.state === 'running'), '조회 로그는 실행 대기 상태일 수 없습니다.')).max(STORED_LOG_LIMIT);
const receipt = z.object({ id, requestId: id, projectId: id, taskId: id.optional(), requestHash: digest.optional(), kind: z.enum(['write','delete','command','access']), state, createdAt: z.number(), updatedAt: z.number() });
const receipts = z.array(receipt).max(STORED_LOG_LIMIT).default([]);
const legacyReceipts = z.array(receipt).max(10000).default([]);
const count = z.number().int().min(0);
const tasks = z.array(z.object({ id, title: z.string().trim().min(1).max(200), counts: z.object({ pending:count, queued:count, running:count, done:count, failed:count, declined:count, cancelled:count }).default(emptyTaskCounts), createdAt:z.number(), updatedAt:z.number(), cancelledAt:z.number().optional() })).max(100).default([]);
const defaultSettings = (): Data['settings'] => ({ approvalMode: 'review', environmentNames: [], rememberAutomatic: false });
const schema = z.object({
  version: z.literal(2), folders,
  settings: z.object({ approvalMode: z.enum(['review','automatic']).default('review'), environmentNames: environmentNames.default([]), rememberAutomatic: z.boolean().default(false) }).default(defaultSettings),
  jobs, receipts, tasks
});
// Read the old 10,000-receipt format once; every subsequent write uses the new limit.
const loadSchema = schema.extend({ receipts: legacyReceipts });

export class Store extends EventEmitter {
  data: Data = { version: 2, folders: [], settings: defaultSettings(), jobs: [], receipts: [], tasks: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private lazyMutations: Mutation[] = [];
  private lazyTimer: NodeJS.Timeout | undefined;
  constructor(private file: string) { super(); }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readPrivateText(this.file,MAX_WORKSPACE_BYTES));
      if (raw?.version === 1) {
        // Preserve granted boundaries and execution logs. Retired task/activity data is omitted.
        const previous = z.object({ version: z.literal(1), projects: folders, jobs, receipts:legacyReceipts }).parse(raw);
        for (const job of previous.jobs) delete job.taskId;
        for (const receipt of previous.receipts) delete receipt.taskId;
        for (const job of previous.jobs) {
          const folder = previous.projects.find(folder => folder.id === job.projectId);
          if (folder) { job.directory = folder.path; if (job.kind !== 'command' && job.path) job.label = path.resolve(folder.path,job.path).slice(0,8000); }
        }
        this.data = loadSchema.parse({ version: 2, folders: previous.projects.filter(folder => folder.approvedFolders.length), settings: defaultSettings(), jobs: previous.jobs, receipts: previous.receipts });
      } else this.data = loadSchema.parse(raw);
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('설정과 실행 로그를 읽을 수 없습니다. 원본을 보존했습니다.');
    }
    // Only a user's explicit persistent opt-in restores authority. Old jobs are never replayed.
    if (!(this.data.settings.approvalMode === 'automatic' && this.data.settings.rememberAutomatic && this.data.folders.length)) {
      this.data.settings.approvalMode = 'review'; this.data.settings.rememberAutomatic = false;
    }
    const beforeRestart = structuredClone(this.data.jobs);
    for (const job of this.data.jobs) {
      if (!job.requestHash && (job.kind === 'command' || job.content !== undefined)) job.requestHash = fingerprint(job);
      if (!terminal(job.state)) {
        job.state = 'cancelled'; job.updatedAt = Date.now();
        job.output = '앱 재시작으로 중단되었습니다. 실제 결과를 확인하세요. 자동 재실행하지 않았습니다.';
      }
      if (job.kind === 'write') { delete job.before; delete job.content; }
      job.output = job.output.slice(-32000);
      if (job.kind === 'read' || job.kind === 'request') continue;
      const receipt = this.data.receipts.find(r => r.requestId === job.requestId);
      if (receipt) { receipt.state = job.state; receipt.updatedAt = job.updatedAt; }
      else this.data.receipts.push({ id: job.id, requestId: job.requestId, projectId: job.projectId, taskId: job.taskId, requestHash: job.requestHash, kind: job.kind, state: job.state, createdAt: job.createdAt, updatedAt: job.updatedAt });
    }
    syncTaskCounts(beforeRestart, this.data.jobs, this.data.tasks);
    for (const receipt of this.data.receipts) if (!terminal(receipt.state)) receipt.state = 'cancelled';
    await this.update(() => {});
  }

  update(mutate: Mutation): Promise<void> {
    const work = this.queue.then(async () => {
      const lazy = this.lazyMutations.splice(0);
      if (this.lazyTimer) { clearTimeout(this.lazyTimer); this.lazyTimer = undefined; }
      let writing = false;
      try {
        const draft = structuredClone(this.data);
        for (const fn of lazy) {
          const before = draft.jobs.map(job => ({ ...job }));
          fn(draft); syncTaskCounts(before, draft.jobs, draft.tasks);
        }
        const before = draft.jobs.map(job => ({ ...job }));
        mutate(draft);
        syncTaskCounts(before, draft.jobs, draft.tasks);
        retainHistory(draft);
        const valid = schema.parse(draft);
        const text = JSON.stringify(valid);
        if (Buffer.byteLength(text) > MAX_WORKSPACE_BYTES) throw new Error('설정과 실행 로그가 256MB를 초과했습니다. 완료 로그를 비우세요.');
        writing = true;
        await atomicPrivateWrite(this.file, text);
        this.data = valid;
        this.emit('change');
      } catch (err) {
        this.lazyMutations = [...lazy, ...this.lazyMutations].slice(-STORED_LOG_LIMIT);
        if (writing) this.emit('warning', '실행 로그 저장에 실패했습니다. 연결을 일시 정지하고 디스크 상태를 확인하세요.');
        throw err;
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }

  /** Read/rejected-request logs only: execution/approval state always uses durable update(). */
  updateLazy(mutate: Mutation): void {
    this.lazyMutations.push(mutate);
    if (this.lazyMutations.length > STORED_LOG_LIMIT) this.lazyMutations.shift();
    if (this.lazyTimer) return;
    this.lazyTimer = setTimeout(() => {
      this.lazyTimer = undefined;
      void this.flushLazy().catch(() => this.emit('warning', '실행 로그를 저장하지 못했습니다. 연결을 일시 정지했습니다.'));
    }, 300);
    this.lazyTimer.unref();
  }

  async flushLazy(): Promise<void> {
    if (this.lazyTimer) { clearTimeout(this.lazyTimer); this.lazyTimer = undefined; }
    if (this.lazyMutations.length) await this.update(() => {});
    await this.queue;
  }
}
