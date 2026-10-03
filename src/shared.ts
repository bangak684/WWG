export const APP_VERSION = '1.0.0';
export const VISIBLE_LOG_LIMIT = 200;
export const STORED_LOG_LIMIT = 1000;
export type ApprovalMode = 'automatic' | 'review';
export interface FolderScope { id: string; path: string; approvedFolders: string[] }
// The file/sandbox layer receives an execution scope, never a project-management model.
export interface Project extends FolderScope { writable: boolean; approvalMode: ApprovalMode; environmentNames: string[] }
export interface Job {
  id: string; requestId: string; projectId: string; taskId?: string;
  kind: 'write' | 'delete' | 'command' | 'access' | 'read' | 'request'; state: 'pending' | 'queued' | 'running' | 'done' | 'failed' | 'declined' | 'cancelled';
  label: string; path?: string; content?: string; expectedHash?: string | null; command?: string; environment?: string[];
  before?: string; requestHash?: string; resultHash?: string; approval?: 'manual' | 'automatic';
  tool?: string; directory?: string;
  output: string; exitCode?: number | null; createdAt: number; updatedAt: number;
}
export interface Receipt { id: string; requestId: string; projectId: string; taskId?: string; requestHash?: string; kind: Job['kind']; state: Job['state']; createdAt: number; updatedAt: number }
export type TaskState = 'waiting' | 'pending' | 'queued' | 'running' | 'stopping' | 'done' | 'failed' | 'cancelled';
export interface Task { id: string; title: string; counts: Record<Job['state'], number>; createdAt: number; updatedAt: number; cancelledAt?: number }
export interface TaskSnapshot extends Task { state: TaskState; totalRequests: number; retainedRequests: number }
export interface Snapshot {
  folders: FolderScope[]; approvalMode: ApprovalMode; environmentNames: string[]; rememberAutomatic: boolean; jobs: Job[]; tasks: TaskSnapshot[];
  connected: boolean; paused: boolean; lastCall: number | null;
  canClearLogs: boolean;
  privacyNoticeAccepted: boolean;
  endpoint: null; error: string | null;
  version: string; runtime?: { packaged: boolean; platform: string; arch: string };
}
export interface FileEntry { name: string; directory: boolean }
export interface FileRead { path: string; content: string; hash: string }
export interface TunnelStatus { installed: boolean; phase: 'stopped' | 'starting' | 'ready' | 'error'; tunnelId: string; message: string }
export type ConnectionLink = 'keys' | 'tunnels' | 'plugins' | 'download' | 'guide' | 'support';
export interface NavigationTarget { tab: 'logs'|'connect'|'settings' }
export interface WorkroomAPI {
  acceptPrivacyNotice(version: number): Promise<void>; quit(): Promise<void>;
  snapshot(): Promise<Snapshot>; selectFolders(): Promise<void>; removeFolder(id: string): Promise<void>;
  startAutomatic(): Promise<void>; stopAutomatic(): Promise<void>;
  setEnvironmentNames(names: string[]): Promise<void>; clearLogs(): Promise<void>;
  decide(id: string, accept: boolean): Promise<void>; cancelJob(id: string): Promise<void>; cancelTask(id: string): Promise<void>;
  pause(value: boolean): Promise<void>;
  tunnelStatus(): Promise<TunnelStatus>; inspectTunnel(): Promise<TunnelStatus>;
  startTunnel(tunnelId: string, apiKey: string): Promise<TunnelStatus>;
  stopTunnel(): Promise<TunnelStatus>;
  openConnectionLink(link: ConnectionLink): Promise<void>;
  copyTunnelId(): Promise<void>;
  onChange(callback: () => void): () => void;
  onNavigate(callback: (target: NavigationTarget) => void): () => void;
}
declare global { interface Window { workroom: WorkroomAPI } }
