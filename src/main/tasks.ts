import type { Job, Task, TaskState } from '../shared';
import path from 'node:path';

export const emptyTaskCounts = (): Task['counts'] => ({ pending: 0, queued: 0, running: 0, done: 0, failed: 0, declined: 0, cancelled: 0 });
export function taskState(task: Task): TaskState {
  const c = task.counts;
  if (task.cancelledAt !== undefined) return c.pending + c.queued + c.running ? 'stopping' : 'cancelled';
  if (c.running) return 'running';
  if (c.pending) return 'pending';
  if (c.queued) return 'queued';
  if (c.failed || c.declined) return 'failed';
  if (c.cancelled) return 'cancelled';
  return c.done ? 'done' : 'waiting';
}

// Counts retain outcomes when detailed logs are evicted. Removing a log is not a new outcome.
export function syncTaskCounts(previous: Job[], current: Job[], tasks: Task[]): void {
  const before = new Map(previous.map(job => [job.id, job]));
  for (const job of current) {
    const old = before.get(job.id);
    if (old && old.taskId !== job.taskId) throw new Error('요청의 작업 묶음은 변경할 수 없습니다.');
    if (!job.taskId || old?.state === job.state) continue;
    const task = tasks.find(task => task.id === job.taskId);
    if (!task) throw new Error('작업을 찾을 수 없습니다.');
    if (old) task.counts[old.state]--;
    task.counts[job.state]++;
    task.updatedAt = Math.max(task.updatedAt, job.updatedAt);
    tasks.unshift(tasks.splice(tasks.indexOf(task),1)[0]!);
    if (['write','delete','command'].includes(job.kind) && ['done','failed','declined','cancelled'].includes(job.state)) {
      const memory={jobId:job.id,taskId:task.id,tool:job.tool,kind:job.kind,state:job.state,path:job.kind!=='command'&&job.directory&&job.path?path.resolve(job.directory,job.path):job.directory,command:job.command?.slice(0,2000),output:job.output.slice(-1000),resultHash:job.resultHash,updatedAt:job.updatedAt};
      task.memory=[memory,...task.memory.filter(entry=>entry.jobId!==job.id)].slice(0,20);
    }
  }
}
