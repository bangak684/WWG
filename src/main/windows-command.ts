import path from 'node:path';
import { existsSync, constants, type BigIntStats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { diskFs as fs } from './disk-fs';
import { protectedName, protectedPath } from './secret-policy';

type Entry = { directory: boolean; stat: BigIntStats; hash?: string };
type Tree = Map<string, Entry>;
type Mapping = { original: string; copy: string; before: Tree; barriers: Set<string> };
const key = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const within = (value: string, root: string): boolean => key(value) === key(root) || key(value).startsWith(key(root) + path.sep);
const unsafe = (name: string): boolean => protectedName(name) || /[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name);
const same = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.nlink === b.nlink;
const check = (authorized: () => boolean): void => { if (!authorized()) throw new Error('Windows 명령 실행 또는 결과 반영 중 권한이 취소되었습니다.'); };

export function windowsRunnerPath(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packaged = resources ? path.join(resources, 'wwg-command.exe') : undefined;
  return packaged && existsSync(packaged) ? packaged : path.resolve(__dirname, '../windows/wwg-command.exe');
}
export function requireWindowsRunner(): void {
  if (process.platform !== 'win32' || !existsSync(windowsRunnerPath())) throw new Error('Windows 명령 격리 실행기가 없습니다. 최신 Windows용 WWG를 사용하세요.');
}
function launcherEnvironment(): NodeJS.ProcessEnv {
  // Userenv needs these locations to create/delete an AppContainer profile.
  // They belong to the trusted launcher only, never to the requested command.
  const environment: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot || 'C:\\Windows' };
  for (const name of ['WINDIR', 'SystemDrive', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'ALLUSERSPROFILE', 'ProgramData', 'PUBLIC', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'USERNAME', 'USERDOMAIN']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

/** Read only the default stream of a checked ordinary file; CopyFile would copy NTFS ADS too. */
async function digestFile(target: string, expected: BigIntStats, authorized: () => boolean, destination?: string, durable = false): Promise<string> {
  check(authorized);
  const input = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const initial = await input.stat({ bigint: true });
    if (!initial.isFile() || !same(initial, expected)) throw new Error('파일이 검사 중 변경되었습니다. 명령을 다시 요청하세요.');
    if (destination) output = await fs.open(destination, 'wx', 0o600);
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      check(authorized);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      if (output) {
        let offset = 0;
        while (offset < bytesRead) offset += (await output.write(buffer, offset, bytesRead - offset)).bytesWritten;
      }
    }
    if (!same(initial, await input.stat({ bigint: true }))) throw new Error('파일이 검사 중 변경되었습니다. 명령을 다시 요청하세요.');
    if (output && durable) await output.sync();
    return hash.digest('hex');
  } finally { await input.close(); await output?.close(); }
}

/** Metadata only on excluded files. Incomplete hard-link groups and reparse aliases never get copied. */
async function inventory(root: string, authorized: () => boolean, forbidden: string[], strict: boolean): Promise<{ tree: Tree; barriers: Set<string> }> {
  const tree: Tree = new Map(), barriers = new Set<string>();
  const pending = [''], links = new Map<string, string[]>(); let count = 0;
  const barrier = (relative: string): void => {
    for (let parent = path.dirname(relative);; parent = path.dirname(parent)) {
      barriers.add(parent === '.' ? '' : parent);
      if (parent === '.' || parent === '') break;
    }
  };
  while (pending.length) {
    check(authorized);
    const relative = pending.pop()!, target = path.join(root, relative);
    const directory = await fs.lstat(target, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink() || key(await fs.realpath(target)) !== key(target)) throw new Error('실제 폴더 경로가 변경되었습니다.');
    tree.set(relative, { directory: true, stat: directory });
    for await (const entry of await fs.opendir(target)) {
      check(authorized);
      if (++count > 200000) throw new Error('안전하게 검사할 수 있는 파일 수를 초과했습니다. 접근 폴더 범위를 줄이세요.');
      const child = path.join(relative, entry.name), full = path.join(root, child);
      if (unsafe(entry.name) || forbidden.some(value => within(full, value))) {
        if (strict) throw new Error('명령이 비밀파일 또는 금지된 경로를 생성했습니다. 원본에 반영하지 않았습니다.');
        barrier(child); continue;
      }
      const stat = await fs.lstat(full, { bigint: true });
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        if (strict) throw new Error('명령 결과에 링크 또는 특수 파일이 있어 원본에 반영하지 않았습니다.');
        barrier(child); continue;
      }
      if (stat.isDirectory()) pending.push(child);
      else {
        tree.set(child, { directory: false, stat });
        if (stat.nlink > 1n) {
          const id = `${stat.dev}:${stat.ino}`, names = links.get(id) ?? [];
          names.push(child); links.set(id, names);
        }
      }
    }
  }
  for (const names of links.values()) if (strict || tree.get(names[0]!)!.stat.nlink !== BigInt(names.length)) {
    if (strict) throw new Error('명령 결과에 하드링크가 있어 원본에 반영하지 않았습니다.');
    for (const name of names) { tree.delete(name); barrier(name); }
  }
  return { tree, barriers };
}

export class WindowsCommandWorkspace {
  readonly profile = `WWG.Command.${randomUUID()}`;
  private mappings: Mapping[] = [];
  private runtimePaths: string[] = [];
  private constructor(readonly stage: string, private authorized: () => boolean) {}

  static async prepare(roots: string[], dataDir: string, authorized: () => boolean, forbidden: string[] = []): Promise<WindowsCommandWorkspace> {
    const base = path.join(dataDir, 'command-workspaces');
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    const workspace = new WindowsCommandWorkspace(await fs.mkdtemp(path.join(base, 'command-')), authorized);
    try {
      const sorted = [...new Set(roots)].sort((a, b) => a.length - b.length), unique: string[] = [];
      for (const root of sorted) if (!unique.some(parent => within(root, parent))) unique.push(root);
      for (const original of unique) {
        check(authorized);
        if (protectedPath(original) || forbidden.some(value => within(original, value))) throw new Error('보호 경로는 Windows 명령에 사용할 수 없습니다.');
        const copy = path.join(workspace.stage, 'folders', String(workspace.mappings.length));
        const { tree: before, barriers } = await inventory(original, authorized, forbidden, false);
        await fs.mkdir(copy, { recursive: true, mode: 0o700 });
        for (const [relative, entry] of before) {
          if (!relative) continue;
          if (entry.directory) await fs.mkdir(path.join(copy, relative), { recursive: true, mode: 0o700 });
          else entry.hash = await digestFile(path.join(original, relative), entry.stat, authorized, path.join(copy, relative));
        }
        workspace.mappings.push({ original, copy, before, barriers });
      }
      await fs.mkdir(path.join(workspace.stage, 'temp'), { mode: 0o700 });
      return workspace;
    } catch (error) { await workspace.dispose(); throw error; }
  }

  /** Standard installations are copied, never granted access in place or inherited through PATH. */
  async prepareRuntimes(command: string): Promise<void> {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    for (const name of ['nodejs', 'Git']) {
      if (!(name === 'Git' ? /\bgit(?:\.exe)?\b/i : /\b(?:node|npm|npx)(?:\.exe|\.cmd)?\b/i).test(command)) continue;
      const original = path.join(programFiles, name);
      try { if (!(await fs.lstat(original)).isDirectory()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const copy = path.join(this.stage, 'runtime', name);
      const { tree } = await inventory(original, this.authorized, [], false);
      await fs.mkdir(copy, { recursive: true });
      for (const [relative, entry] of tree) {
        if (!relative) continue;
        if (entry.directory) await fs.mkdir(path.join(copy, relative), { recursive: true });
        else await digestFile(path.join(original, relative), entry.stat, this.authorized, path.join(copy, relative));
      }
      this.runtimePaths.push(...(name === 'Git' ? [path.join(copy, 'cmd'), path.join(copy, 'bin'), path.join(copy, 'usr', 'bin')] : [copy]));
    }
  }

  mappedPath(original: string): string {
    const mapping = this.mappings.find(value => within(original, value.original));
    if (!mapping) throw new Error('명령 경로가 접근 허용 폴더 밖입니다.');
    return path.join(mapping.copy, path.relative(mapping.original, original));
  }
  mappedCommand(command: string): string {
    // Literal full grant paths and their slash variants work across multiple folders.
    // Encoded/dynamically reconstructed host paths remain inaccessible to the LPAC.
    for (const mapping of [...this.mappings].sort((a,b) => b.original.length - a.original.length)) {
      for (const source of [mapping.original, mapping.original.replaceAll('\\', '/')]) {
        const regex = new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=[\\\\/"\'\\s&|<>)]|$)', 'gi');
        command = command.replace(regex, () => mapping.copy);
      }
    }
    return command;
  }
  environment(selected: Record<string, string>): NodeJS.ProcessEnv {
    const system = process.env.SystemRoot || 'C:\\Windows';
    return { ...selected, SystemRoot: system, WINDIR: system, SystemDrive: path.parse(system).root.replace(/[\\/]$/, ''), ComSpec: path.join(system, 'System32', 'cmd.exe'),
      USERPROFILE: path.join(this.stage, 'temp'), HOME: path.join(this.stage, 'temp'), APPDATA: path.join(this.stage, 'temp'), LOCALAPPDATA: path.join(this.stage, 'temp'),
      PATH: [...this.runtimePaths, path.join(system, 'System32'), path.join(system, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
      TEMP: path.join(this.stage, 'temp'), TMP: path.join(this.stage, 'temp'), NO_COLOR: '1', TERM: 'dumb',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', PYTHONNOUSERSITE: '1', npm_config_userconfig: 'NUL', npm_config_cache: path.join(this.stage, 'temp', 'npm-cache') };
  }
  spawn(cwd: string, command: string, selected: Record<string, string>): ChildProcess {
    requireWindowsRunner(); check(this.authorized);
    const child = spawn(windowsRunnerPath(), [], { windowsHide: true, shell: false, env: launcherEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin!.on('error', () => {}); // A rejected launcher may close stdin before the JSON arrives.
    child.stdin!.end(JSON.stringify({ profile: this.profile, stage: this.stage, cwd: this.mappedPath(cwd), command: this.mappedCommand(command), environment: this.environment(selected) }));
    return child;
  }

  async synchronize(): Promise<void> {
    const changes: { mapping: Mapping; after: Tree; writes: string[]; deletes: string[]; removedDirs: string[]; addedDirs: string[] }[] = [];
    // Plan and validate every scope before applying anything.
    for (const mapping of this.mappings) {
      check(this.authorized);
      const { tree: after } = await inventory(mapping.copy, this.authorized, [], true);
      for (const barrier of mapping.barriers) if (!after.get(barrier)?.directory) throw new Error('비밀파일 또는 제외된 링크가 있는 폴더는 이동·삭제할 수 없습니다. 원본에 반영하지 않았습니다.');
      for (const [relative, entry] of after) if (!entry.directory) entry.hash = await digestFile(path.join(mapping.copy, relative), entry.stat, this.authorized);
      const writes = [...after].filter(([name, value]) => !value.directory && mapping.before.get(name)?.hash !== value.hash).map(([name]) => name);
      const deletes = [...mapping.before].filter(([name, value]) => !value.directory && !after.has(name)).map(([name]) => name);
      const removedDirs = [...mapping.before].filter(([name, value]) => name && value.directory && !after.has(name)).map(([name]) => name).sort((a,b) => b.length-a.length);
      const addedDirs = [...after].filter(([name, value]) => name && value.directory && !mapping.before.has(name)).map(([name]) => name).sort((a,b) => a.length-b.length);
      for (const relative of new Set([...writes, ...deletes, ...removedDirs, ...addedDirs])) {
        const old = mapping.before.get(relative);
        await this.checkOriginal(mapping, relative, old, true);
        if (old && !old.directory && await digestFile(path.join(mapping.original, relative), old.stat, this.authorized) !== old.hash) throw new Error('실행 중 원본 파일이 변경되어 결과를 덮어쓰지 않았습니다.');
        // File/directory swaps complicate secret-preserving publication; fail before any mutation.
        if (old && after.has(relative) && old.directory !== after.get(relative)!.directory) throw new Error('파일과 폴더의 형식 변경은 파일 도구로 나누어 요청하세요.');
      }
      changes.push({ mapping, after, writes, deletes, removedDirs, addedDirs });
    }
    for (const { mapping, after, writes, deletes, removedDirs, addedDirs } of changes) {
      for (const relative of addedDirs) { await this.checkOriginal(mapping, relative); check(this.authorized); await fs.mkdir(path.join(mapping.original, relative)); }
      for (const relative of writes) {
        const destination = path.join(mapping.original, relative), temp = path.join(path.dirname(destination), `.workroom-${randomUUID()}.tmp`);
        try {
          const hash = await digestFile(path.join(mapping.copy, relative), after.get(relative)!.stat, this.authorized, temp, true);
          if (hash !== after.get(relative)!.hash) throw new Error('명령 결과가 반영 중 변경되었습니다.');
          await this.checkOriginal(mapping, relative, mapping.before.get(relative)); check(this.authorized);
          if (mapping.before.has(relative)) await fs.rename(temp, destination);
          else { await fs.link(temp, destination); await fs.unlink(temp); }
        } finally { await fs.rm(temp, { force: true }); }
      }
      for (const relative of deletes) { await this.checkOriginal(mapping, relative, mapping.before.get(relative)); check(this.authorized); await fs.unlink(path.join(mapping.original, relative)); }
      for (const relative of removedDirs) {
        await this.checkOriginal(mapping, relative, mapping.before.get(relative)); check(this.authorized);
        // Never recursive: newly introduced secrets or concurrent user files survive.
        await fs.rmdir(path.join(mapping.original, relative));
      }
    }
  }
  private async checkOriginal(mapping: Mapping, relative: string, expected?: Entry, directoryRevision = false): Promise<void> {
    check(this.authorized);
    if (relative.split(path.sep).some(unsafe)) throw new Error('금지된 파일 경로입니다.');
    for (let current = mapping.original, i = -1; i < relative.split(path.sep).length; i++) {
      if (i >= 0) current = path.join(current, relative.split(path.sep)[i]!);
      const last = i === relative.split(path.sep).length - 1;
      try {
        const stat = await fs.lstat(current, { bigint: true });
        if (stat.isSymbolicLink() || (!last && !stat.isDirectory()) || key(await fs.realpath(current)) !== key(current)) throw new Error('원본 경로가 변경되었습니다.');
        const root = mapping.before.get('')!.stat;
        if (i === -1 && (stat.dev !== root.dev || stat.ino !== root.ino)) throw new Error('원본 접근 폴더가 변경되었습니다.');
        if (last && (!expected || (expected.directory
          ? !stat.isDirectory() || stat.dev !== expected.stat.dev || stat.ino !== expected.stat.ino || (directoryRevision && stat.mtimeNs !== expected.stat.mtimeNs)
          : stat.dev !== expected.stat.dev || stat.ino !== expected.stat.ino || stat.size !== expected.stat.size || stat.mtimeNs !== expected.stat.mtimeNs || stat.nlink > expected.stat.nlink))) throw new Error('실행 중 원본이 변경되어 결과를 덮어쓰지 않았습니다.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !expected) return;
        throw error;
      }
    }
  }
  async dispose(): Promise<void> {
    if (process.platform === 'win32' && existsSync(windowsRunnerPath())) await new Promise<void>(resolve => {
      const child = spawn(windowsRunnerPath(), ['--cleanup', this.profile], { windowsHide: true, stdio: 'ignore', env: launcherEnvironment() });
      child.once('error', () => resolve()); child.once('close', () => resolve());
    });
    await fs.rm(this.stage, { recursive: true, force: true });
  }
}
