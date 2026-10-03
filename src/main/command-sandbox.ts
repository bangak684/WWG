import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Project } from '../shared';
import { protectedPath, protectedPathPatterns, requireSafeRoot } from './secret-policy';

const literal = (value: string): string => '(literal ' + JSON.stringify(value) + ')';
const subtree = (value: string): string => '(subpath ' + JSON.stringify(value) + ')';

/** Every command, including reviewed commands, has the same non-overridable file boundary. */
export function commandSandbox(project: Project, networkAllowed = false, protectedTargets: string[] = [], protectedParents: string[] = [], otherScopes: Project[] = []): string {
  if (process.platform !== 'darwin') throw new Error('이 OS에서는 비밀파일 차단을 위한 명령의 폴더 격리를 지원하지 않아 셸 명령을 실행할 수 없습니다.');
  const scopes = [project,...otherScopes];
  const folders = new Set<string>(), ancestors = new Set<string>(['/']);
  for (const scope of scopes) {
    requireSafeRoot(scope.path);
    for (const folder of scope.approvedFolders) {
      const target = path.resolve(scope.path,folder); requireSafeRoot(target);
      if (target !== scope.path && !target.startsWith(scope.path + path.sep)) throw new Error('접근 범위 밖의 폴더입니다.');
      folders.add(target);
      for (let parent = target; parent !== '/'; parent = path.dirname(parent)) ancestors.add(parent);
    }
  }
  if (!folders.size) throw new Error('명령을 실행하려면 접근 폴더를 먼저 선택하세요.');
  const runtime = ['/System/Library', '/usr/bin', '/usr/lib', '/usr/share', '/bin', '/sbin', '/private/var/select'];
  const readable = [...ancestors].map(literal).concat(runtime.map(subtree), [...folders].map(subtree));
  readable.push(literal('/dev/null'));
  // OS-owned public TLS/DNS data, not user credentials or user certificate files.
  const publicCA = '/private/etc/ssl/cert.pem';
  if (networkAllowed) readable.push(...['/private/etc/ssl/openssl.cnf', publicCA, '/private/etc/resolv.conf', '/private/etc/hosts', '/private/etc/services', '/private/etc/protocols', '/dev/urandom', '/dev/random'].map(literal));
  const writable = [...folders].map(subtree).concat(literal('/dev/null'));
  const protectedFilters = protectedPathPatterns.map(pattern => '(regex #' + JSON.stringify(pattern) + ')').join(' ');
  return '(version 1)(deny default)(allow process-exec)(allow process-fork)' +
    '(allow file-read* ' + readable.join(' ') + ')' +
    '(allow file-write* ' + writable.join(' ') + ')' +
    // macOS also checks file-link when renaming an existing multiply-linked file.
    '(allow file-link ' + [...folders].map(subtree).join(' ') + ')' +
    // Explicit deny overrides a folder grant, including rename/copy/exec attempts.
    '(deny file-write* file-link process-exec ' + protectedFilters + protectedTargets.map(subtree).join(' ') + ')' +
    '(deny file-read* (require-all (require-any ' + protectedFilters + ') (require-not ' + literal(publicCA) + ')) ' + protectedTargets.map(subtree).join(' ') + ')' +
    // Renaming a directory moves all its children without accessing their paths.
    (protectedParents.length ? '(deny file-write-unlink ' + protectedParents.map(literal).join(' ') + ')' : '') +
    (networkAllowed ? '(allow network*)' : '');
}

/** Inspect aliases without reading contents. Ordinary, fully accounted-for hard links are allowed. */
export async function inspectCommandTree(project: Project, authorized: () => boolean, otherScopes: Project[] = []): Promise<{targets:string[]; protectedParents:string[]}> {
  const scopes = [project,...otherScopes];
  const roots = [...new Set(scopes.flatMap(scope => scope.approvedFolders.map(folder => path.resolve(scope.path,folder))))];
  const withinGrant = (target: string): boolean => roots.some(root => target === root || target.startsWith(root + path.sep));
  const targets = new Set<string>(); const protectedParents = new Set<string>(); let scanned = 0;
  const hardLinks = new Map<string, {links:bigint; paths:string[]}>();
  const protectParents = (target: string): void => {
    for (let parent = path.dirname(target); withinGrant(parent); parent = path.dirname(parent)) protectedParents.add(parent);
  };
  const deniedTarget = (target: string): boolean => {
    for (let current = target;; current = path.dirname(current)) {
      if (targets.has(current)) return true;
      if (current === path.dirname(current)) return false;
    }
  };
  const visited = new Set<string>(); const pending = [...roots];
  while (pending.length) {
    if (!authorized()) throw new Error('명령 검사 중 권한이 취소되었습니다.');
    const directory = pending.pop()!; if (visited.has(directory)) continue; visited.add(directory);
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (++scanned > 200000) throw new Error('안전하게 검사할 수 있는 파일 수를 초과했습니다. 승인 폴더 범위를 줄이세요.');
      if (!authorized()) throw new Error('명령 검사 중 권한이 취소되었습니다.');
      const target = path.join(directory, entry.name); const stat = await fs.lstat(target, {bigint:true});
      if (stat.isFile() && stat.nlink > 1n) {
        const identity = `${stat.dev}:${stat.ino}`;
        const links = hardLinks.get(identity) ?? {links:stat.nlink, paths:[]};
        links.links = links.links > stat.nlink ? links.links : stat.nlink;
        links.paths.push(target); hardLinks.set(identity, links);
      }
      if (protectedPath(target)) {
        protectParents(target);
        if (stat.isSymbolicLink()) { const real = await fs.realpath(target); targets.add(real); protectParents(real); }
        else if (stat.isDirectory()) pending.push(target);
        continue;
      }
      if (stat.isDirectory()) pending.push(target);
      else if (stat.isSymbolicLink()) {
        // In-tree package links may be useful, but an alias cannot introduce an uninspected tree.
        const real = await fs.realpath(target);
        if (!withinGrant(real)) targets.add(real);
      } else if (!stat.isFile()) throw new Error('특수 파일이 있는 폴더에서는 명령을 실행할 수 없습니다.');
    }
  }
  for (const group of hardLinks.values()) {
    if (!authorized()) throw new Error('명령 검사 중 권한이 취소되었습니다.');
    // Every inode name must be inside the inspected grant. An unseen external name may be a secret.
    if (group.links !== BigInt(group.paths.length) || group.paths.some(target => protectedPath(target) || deniedTarget(target))) {
      for (const target of group.paths) { targets.add(target); protectParents(target); }
    }
  }
  return {targets:[...targets],protectedParents:[...protectedParents]};
}
