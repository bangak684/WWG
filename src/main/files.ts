import { constants } from 'node:fs';
import { diskFs as fs } from './disk-fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Project, FileRead, FileEntry } from '../shared';
import { syncDirectory } from './private-io';
import { protectedName, requireSafeRoot } from './secret-policy';

const MAX_FILE = 256 * 1024;
const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const unsafeWindowsPart = (name: string): boolean => process.platform === 'win32' && (/[<>:"|?*]/.test(name) || /[. ]$/.test(name) || windowsReserved.test(name));
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export function approved(project: Project, relative: string): boolean {
  if (path.isAbsolute(relative) || relative.includes('\\')) return false;
  const parts = relative.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..' || blocked(part) || unsafeWindowsPart(part))) return false;
  const value = parts.join('/');
  return (project.approvedFolders ?? []).some(folder => !folder || value === folder || value.startsWith(folder + '/'));
}
export function requireApproved(project: Project, relative: string): void {
  if (!approved(project, relative)) throw new Error('이 폴더는 접근 승인이 필요합니다. WWG에서 폴더 권한을 지정하세요.');
}
const blocked = (name: string): boolean => protectedName(name) || name.toLowerCase() === 'node_modules';
export function validateContent(content: string): void {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_FILE) throw new Error('파일은 256KB 이하의 UTF-8 텍스트여야 합니다.');
  if (content.includes('\0') || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(content)) !== content) throw new Error('NUL 또는 잘못된 Unicode 문자는 저장할 수 없습니다.');
}

/** Canonical root checks do not claim isolation from a malicious same-user OS process. */
export async function resolveFile(project: Project, relative: string, allowMissing = false): Promise<string> {
  if (typeof relative !== 'string' || relative.length > 1024 || path.isAbsolute(relative) || relative.includes('\\') || /[\x00-\x1f\x7f]/.test(relative)) throw new Error('프로젝트 기준 상대 경로를 사용하세요.');
  const parts = relative.split('/').filter(part => part !== '' && part !== '.');
  if (parts.some(part => part === '..' || blocked(part) || unsafeWindowsPart(part))) throw new Error('허용되지 않는 경로입니다.');
  const root = await fs.realpath(project.path);
  requireSafeRoot(root);
  if (root !== project.path || !(await fs.lstat(root)).isDirectory()) throw new Error('프로젝트 경로가 변경되었습니다. 폴더를 다시 등록하세요.');
  let target = root;
  for (let i = 0; i < parts.length; i++) {
    target = path.join(target, parts[i]!);
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error('심볼릭 링크는 열 수 없습니다.');
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('특수 파일은 열 수 없습니다.');
      if (stat.isFile() && stat.nlink !== 1) throw new Error('하드링크 파일은 열 수 없습니다.');
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('부모 경로가 디렉터리가 아닙니다.');
    } catch (err) {
      if (allowMissing && i === parts.length - 1 && (err as NodeJS.ErrnoException).code === 'ENOENT') return target;
      throw err;
    }
  }
  return target;
}
export async function listFiles(project: Project, relative: string): Promise<FileEntry[]> {
  const target = await resolveFile(project, relative);
  if (!(await fs.lstat(target)).isDirectory()) throw new Error('파일 목록 조회에는 실제 폴더의 경로를 지정하세요.');
  const directory = await fs.opendir(target);
  const entries: FileEntry[] = [];
  let scanned = 0;
  for await (const entry of directory) {
    if (++scanned > 10000) break;
    if (entry.isSymbolicLink() || blocked(entry.name) || unsafeWindowsPart(entry.name) || (!entry.isDirectory() && !entry.isFile())) continue;
    entries.push({ name: entry.name, directory: entry.isDirectory() });
    if (entries.length >= 500) break;
  }
  return entries.sort((a,b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}
export async function readFile(project: Project, relative: string): Promise<FileRead> {
  const target = await resolveFile(project, relative);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE) throw new Error('미리보기는 256KB 이하의 일반 단일 링크 텍스트 파일만 지원합니다.');
    const buffer = Buffer.alloc(MAX_FILE + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE) throw new Error('파일이 허용 크기를 초과했습니다.');
    const bytes = buffer.subarray(0, offset);
    if (bytes.includes(0)) throw new Error('바이너리 파일은 텍스트로 열 수 없습니다.');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { path: relative, content, hash: hash(content) };
  } finally { await handle.close(); }
}
export async function writeFile(project: Project, relative: string, content: string, expectedHash: string | null, authorized: () => boolean = () => project.writable): Promise<void> {
  if (!project.writable) throw new Error('프로젝트의 변경 허용을 먼저 켜세요.');
  validateContent(content);
  const target = await resolveFile(project, relative, true);
  if (target === project.path) throw new Error('파일 경로가 필요합니다.');
  await checkRevision(project, relative, expectedHash);
  const tmp = path.join(path.dirname(target), `.workroom-${randomUUID()}.tmp`);
  let mode = 0o600;
  try { mode = (await fs.stat(target)).mode & 0o777; } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8'); await handle.chmod(mode); await handle.sync(); await handle.close();
    await resolveFile(project, relative, true);
    await checkRevision(project, relative, expectedHash);
    if (!authorized()) throw new Error('저장 전에 변경 권한이 취소되었습니다.');
    if (expectedHash === null) { await fs.link(tmp, target); await fs.unlink(tmp); }
    else await fs.rename(tmp, target);
    try { await syncDirectory(path.dirname(target)); }
    catch { throw new Error('파일 변경은 적용됐지만 디렉터리 저장 확인에 실패했습니다. 실제 파일을 확인하세요.'); }
  } finally { await handle.close().catch(() => {}); await fs.rm(tmp, { force: true }); }
}
export async function deleteFile(project: Project, relative: string, expectedHash: string, authorized: () => boolean = () => project.writable): Promise<void> {
  if (!project.writable) throw new Error('프로젝트의 변경 허용을 먼저 켜세요.');
  await checkRevision(project, relative, expectedHash);
  await resolveFile(project, relative);
  if (!authorized()) throw new Error('삭제 전에 변경 권한이 취소되었습니다.');
  await checkRevision(project, relative, expectedHash);
  if (!authorized()) throw new Error('삭제 전에 변경 권한이 취소되었습니다.');
  await fs.unlink(path.join(project.path, relative));
  await syncDirectory(path.dirname(path.join(project.path, relative)));
}
export async function checkRevision(project: Project, relative: string, expected: string | null): Promise<string> {
  try {
    const current = await readFile(project, relative);
    if (expected === null || current.hash !== expected) throw new Error('파일이 변경되었습니다. 다시 읽고 새 변경안을 요청하세요.');
    return current.content;
  } catch (err) { if (expected === null && (err as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw err; }
}
