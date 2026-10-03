import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function ensurePrivateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('데이터 폴더는 실제 디렉터리여야 합니다.');
  if (process.getuid && stat.uid !== process.getuid()) throw new Error('데이터 폴더 소유자를 확인하세요.');
  if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
}

async function regularTarget(file: string, allowMissing: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('링크 또는 특수 데이터 파일은 사용할 수 없습니다.');
    if (process.getuid && stat.uid !== process.getuid()) throw new Error('데이터 파일 소유자를 확인하세요.');
  } catch (err) {
    if (allowMissing && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

export async function readPrivateText(file: string, limit = 32 * 1024 * 1024): Promise<string> {
  await regularTarget(file, false);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('데이터 파일 형식 또는 크기가 허용 범위를 벗어났습니다.');
    const buffer = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > stat.size || offset > limit) throw new Error('읽는 동안 데이터 파일이 변경되었습니다.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
  } finally { await handle.close(); }
}

export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, constants.O_RDONLY);
  try { await handle.sync(); }
  catch (err) { if (!['EINVAL', 'ENOTSUP'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err; }
  finally { await handle.close(); }
}

/** Unique exclusive temp, restrictive permissions, fsync, then atomic replacement. */
export async function atomicPrivateWrite(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await ensurePrivateDirectory(dir);
  await regularTarget(file, true);
  const temp = path.join(dir, `.workroom-state-${randomUUID()}.tmp`);
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    await regularTarget(file, true);
    await fs.rename(temp, file);
    await syncDirectory(dir);
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(temp, { force: true });
  }
}
