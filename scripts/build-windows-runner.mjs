import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildWindowsRunner() {
  if (process.platform !== 'win32') throw new Error('Build the Windows command runner on Windows.');
  const system = process.env.SystemRoot || 'C:\\Windows';
  const compiler = path.join(system, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const output = path.join(root, 'out', 'windows', 'wwg-command.exe');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.Web.Extensions.dll', `/out:${output}`, path.join(root, 'src', 'native', 'WindowsCommand.cs')], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Windows runner compiler exited with ${code}`)));
  });
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWindowsRunner();
