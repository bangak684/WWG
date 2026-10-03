import { STORED_LOG_LIMIT, VISIBLE_LOG_LIMIT, type Job, type Receipt, type Task } from '../shared';
import { terminal } from './request';
import { emptyTaskCounts } from './tasks';

interface History { jobs: Job[]; receipts: Receipt[]; tasks: Task[] }

/** A job and its retry receipt occupy one place in the same retention window. */
export function retainHistory(history: History): void {
  const records = new Map<string, { id: string; taskId?: string; state: Job['state']; createdAt: number; order: number }>();
  for (const job of history.jobs) records.set(job.id, { id:job.id, taskId:job.taskId, state:job.state, createdAt:job.createdAt, order:records.size });
  for (const receipt of [...history.receipts].reverse()) if (!records.has(receipt.id)) records.set(receipt.id, { id:receipt.id, taskId:receipt.taskId, state:receipt.state, createdAt:receipt.createdAt, order:records.size });
  const ordered = [...records.values()].sort((a,b) => b.createdAt-a.createdAt || a.order-b.order);
  const retained = new Set(history.jobs.filter(job => !terminal(job.state)).map(job => job.id));
  if (retained.size > VISIBLE_LOG_LIMIT) throw new Error(`대기·실행 요청은 최대 ${VISIBLE_LOG_LIMIT}개입니다. 일부를 완료하거나 취소하세요.`);
  for (const record of ordered) {
    if (retained.size >= STORED_LOG_LIMIT) break;
    retained.add(record.id);
  }
  history.jobs = history.jobs.filter(job => retained.has(job.id));
  history.receipts = history.receipts.filter(receipt => retained.has(receipt.id));

  // Expired outcomes must not survive as task counters or orphaned task titles.
  const grouped = new Map<string, Task['counts']>();
  for (const record of ordered) if (retained.has(record.id) && record.taskId) {
    const counts = grouped.get(record.taskId) ?? emptyTaskCounts();
    counts[record.state]++; grouped.set(record.taskId,counts);
  }
  history.tasks = history.tasks.filter(task => {
    const counts = grouped.get(task.id);
    if (!counts && Object.values(task.counts).some(count => count > 0)) return false;
    task.counts = counts ?? emptyTaskCounts();
    return true;
  });
}

/** Keep every approval/active request visible, then fill the screen with recent outcomes. */
export function visibleLogs(jobs: Job[]): Job[] {
  const active = jobs.filter(job => !terminal(job.state));
  const visible = new Set(active.map(job => job.id));
  for (const job of jobs) {
    if (visible.size >= VISIBLE_LOG_LIMIT) break;
    visible.add(job.id);
  }
  return jobs.filter(job => visible.has(job.id));
}
