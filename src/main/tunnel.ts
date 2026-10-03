import { EventEmitter } from 'node:events';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { TunnelStatus } from '../shared';
import { atomicPrivateWrite, readPrivateText } from './private-io';

const tunnelIdSchema = z.string().trim().regex(/^tunnel_[a-zA-Z0-9_-]{8,128}$/);
// Never include a rejected input in an IPC error or diagnostic.
export function validateTunnelInput(id: unknown, key: unknown): { id: string; key: string } {
  const parsed = tunnelIdSchema.safeParse(id);
  if (!parsed.success) throw new Error('터널 ID는 tunnel_로 시작하는 실제 ID를 입력하세요.');
  if (typeof key !== 'string' || !/^sk-[A-Za-z0-9_-]{12,1024}$/.test(key.trim())) throw new Error('유효한 런타임 API 키를 입력하세요.');
  return { id: parsed.data, key: key.trim() };
}

export function tunnelEnvironment(key?: string, endpoint?: string): NodeJS.ProcessEnv {
  // Do not inherit profiles, proxy destinations, logging flags or unrelated credentials.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['HOME','TMPDIR','LANG','LC_ALL','SystemRoot','USERPROFILE','TEMP','TMP','APPDATA','LOCALAPPDATA']) if (process.env[name]) env[name] = process.env[name];
  env.PATH = process.platform === 'win32'
    ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`
    : '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  if (key) env.WORKROOM_TUNNEL_API_KEY = key;
  if (endpoint) env.MCP_SERVER_URL = endpoint;
  return env;
}

export class Tunnel extends EventEmitter {
  private state: TunnelStatus = { installed: false, phase: 'stopped', tunnelId: '', message: '터널 ID와 런타임 API 키를 입력해 연결하세요.' };
  private binary: string | undefined;
  private child: ChildProcess | undefined;
  private timer: NodeJS.Timeout | undefined;
  private probe: ChildProcess | undefined;
  private stopping: Promise<void> | undefined;
  private busy = false;
  private generation = 0;
  private healthFile: string;
  constructor(private readonly dataDir: string, private readonly candidates?: string[], private readonly pollMs = 3000) {
    super(); this.healthFile = path.join(dataDir,'tunnel-health.url');
  }
  snapshot(): TunnelStatus { return { ...this.state }; }
  private update(patch: Partial<TunnelStatus>): void {
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) !== JSON.stringify(this.state)) { this.state = next; this.emit('change'); }
  }
  async inspect(): Promise<TunnelStatus> {
    if (!this.child && !this.busy) {
      const candidates = this.candidates ?? (process.platform === 'win32'
        ? [path.join(this.dataDir,'bin','tunnel-client.exe')]
        : ['/opt/homebrew/bin/tunnel-client','/usr/local/bin/tunnel-client']);
      let detected: string | undefined;
      for (const candidate of candidates) {
        try {
          if (!path.isAbsolute(candidate)) continue;
          const real = await fs.realpath(candidate);
          await fs.access(real, constants.X_OK);
          const stat = await fs.stat(real);
          const owner = !process.getuid || stat.uid === 0 || stat.uid === process.getuid();
          if (stat.isFile() && owner && (process.platform === 'win32' || (stat.mode & 0o022) === 0)) { detected = real; break; }
        } catch { /* not a usable local executable */ }
      }
      this.binary = detected;
      this.update({ installed: !!this.binary });
      if (!this.state.tunnelId) {
        try { const saved = JSON.parse(await readPrivateText(path.join(this.dataDir,'tunnel-settings.json'),4096)); const id=tunnelIdSchema.safeParse(saved.tunnelId); if(id.success) this.update({ tunnelId: id.data }); } catch { /* optional settings */ }
      }
    }
    return this.snapshot();
  }
  async start(id: unknown, key: unknown, endpoint: string | null): Promise<TunnelStatus> {
    if (this.busy || this.child || this.stopping) throw new Error('터널 작업이 진행 중입니다. 먼저 연결을 중지하세요.');
    const input = validateTunnelInput(id,key);
    if (!endpoint) throw new Error('로컬 MCP 서버가 준비되지 않았습니다.');
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new Error('로컬 MCP 주소를 확인할 수 없습니다.');
    this.busy = true;
    const generation = ++this.generation;
    try {
      // inspect must happen outside the busy guard.
      if (!this.binary) throw new Error('tunnel-client를 설치한 뒤 설치 다시 확인을 누르세요.');
      await fs.mkdir(this.dataDir,{recursive:true,mode:0o700});
      await fs.rm(this.healthFile,{force:true});
      await atomicPrivateWrite(path.join(this.dataDir,'tunnel-settings.json'),JSON.stringify({tunnelId:input.id}));
      if (generation !== this.generation) throw new Error('연결이 취소되었습니다.');
      this.update({ phase:'starting', tunnelId:input.id, message:'OpenAI 터널 인증과 도구 연결을 확인하고 있습니다. 첫 확인에는 최대 1분 정도 걸릴 수 있습니다.' });
      const child = spawn(this.binary,[
        'run','--control-plane.tunnel-id',input.id,
        '--control-plane.base-url','https://api.openai.com',
        '--control-plane.api-key','env:WORKROOM_TUNNEL_API_KEY',
        '--health.listen-addr','127.0.0.1:0','--health.url-file',this.healthFile,
        '--log.format','json','--log.level','warn'
      ],{ env:tunnelEnvironment(input.key,endpoint),stdio:['ignore','pipe','pipe'],windowsHide:true });
      // Key is never persisted, returned to the renderer, placed in argv, or retained here.
      input.key = '';
      this.child = child;
      let diagnostic = '';
      const consume = (chunk: Buffer): void => {
        // Classify only: never forward or save raw child output, which may contain secrets.
        const output = chunk.toString().toLowerCase();
        if (/\b401\b|invalid_api_key|unauthorized/.test(output)) diagnostic = 'API 키 인증에 실패했습니다. 올바른 조직의 런타임 API 키를 확인하세요.';
        else if (/\b403\b|forbidden|permission.denied/.test(output)) diagnostic = '터널 접근 권한이 없습니다. 키 소유자의 Tunnels Read + Use 권한과 조직을 확인하세요.';
        else if (/\b404\b|tunnel.not.found/.test(output)) diagnostic = '터널을 찾을 수 없습니다. 터널 ID와 키의 조직을 확인하세요.';
        if (diagnostic && this.child === child) this.update({phase:'error',message:diagnostic});
      };
      child.stdout?.on('data',consume); child.stderr?.on('data',consume);
      child.on('error',()=>{ if (this.child===child) this.update({phase:'error',message:'tunnel-client를 실행하지 못했습니다. 설치 상태를 다시 확인하세요.'}); });
      child.on('close',()=>{
        if (this.child!==child) return;
        this.child=undefined; clearInterval(this.timer); this.timer=undefined;
        this.update({phase:'error',message:diagnostic || '터널 프로세스가 종료되었습니다. 키·터널 ID·네트워크를 확인하고 다시 연결하세요.'});
      });
      const started=Date.now();
      this.timer=setInterval(()=>{ void this.check(child,generation,started).catch(()=>{if(this.child===child)this.update({phase:'error',message:'터널 상태 확인에 실패했습니다. 중지 후 다시 연결하세요.'});}); },this.pollMs);
      return this.snapshot();
    } finally { input.key=''; this.busy=false; }
  }
  private async check(child: ChildProcess, generation: number, started: number): Promise<void> {
    if (this.probe || this.child!==child || generation!==this.generation) return;
    try {
      const healthURL = new URL((await readPrivateText(this.healthFile,4096)).trim());
      if (healthURL.protocol !== 'http:' || healthURL.hostname !== '127.0.0.1' || healthURL.username || healthURL.password || healthURL.search || healthURL.hash) throw new Error('Invalid health endpoint');
    } catch {
      if (this.child===child && Date.now()-started>90000 && this.state.phase==='starting') this.update({phase:'error',message:'터널 상태를 확인하지 못했습니다. 클라이언트를 업데이트하고 중지 후 다시 연결하세요.'});
      return;
    }
    if (this.child!==child || generation!==this.generation) return;
    // Exit success requires a successful OpenAI control-plane poll, not just a local listener.
    const healthy = await new Promise<boolean>(resolve=>{
      this.probe=execFile(this.binary!,['health','--url-file',this.healthFile,'--require-control-plane-poll','--json'],{env:tunnelEnvironment(),timeout:5000,maxBuffer:64*1024},error=>{this.probe=undefined;resolve(!error);});
    });
    if (this.child!==child || generation!==this.generation) return;
    if (healthy) this.update({phase:'ready',message:'OpenAI 터널이 준비되었습니다. 맞춤형 MCP 서버 만들기 화면에서 이 터널을 지정해 생성을 완료한 뒤, 웹 ChatGPT 대화에서 WWG를 선택하세요.'});
    else if(this.state.phase==='ready') this.update({phase:'starting',message:'터널 연결이 불안정합니다. 다시 확인하고 있습니다.'});
    else if(Date.now()-started>90000 && this.state.phase==='starting') this.update({phase:'error',message:'연결 확인 시간이 초과되었습니다. API 키, 터널 권한, 네트워크를 확인한 뒤 중지하고 다시 연결하세요.'});
  }
  async stop(): Promise<TunnelStatus> {
    if(this.stopping){await this.stopping;return this.snapshot();}
    ++this.generation; clearInterval(this.timer); this.timer=undefined;
    this.probe?.kill(); this.probe=undefined;
    const child=this.child; this.child=undefined;
    this.stopping=(async()=>{
      if(child && child.pid && child.exitCode===null && child.signalCode===null) await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>child.kill('SIGKILL'),1000);
        const limit=setTimeout(()=>{clearTimeout(timer);reject(new Error('터널 종료를 확인하지 못했습니다. 프로세스 상태를 확인하세요.'));},4000);
        child.once('close',()=>{clearTimeout(timer);clearTimeout(limit);resolve();});child.kill('SIGTERM');
      });
      await fs.rm(this.healthFile,{force:true});
      this.update({phase:'stopped',message:'터널이 중지되었습니다. 다시 연결할 때 API 키를 입력하세요.'});
    })();
    try { await this.stopping; } finally { this.stopping=undefined; }
    return this.snapshot();
  }
}
