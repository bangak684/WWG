import { z } from 'zod';

export const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export const environmentNames = z.array(environmentName).max(32).refine(names => new Set(names).size === names.length, '중복된 환경변수 이름입니다.');
const reserved = /^(?:PATH|HOME|USERPROFILE|TMPDIR|TMP|TEMP|APPDATA|LOCALAPPDATA|SystemRoot|SystemDrive|WINDIR|PSModulePath|PSModuleAnalysisCachePath|PSExecutionPolicyPreference|COMSPEC|ProgramFiles(?:\(x86\))?|ProgramW6432|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|CDPATH|IFS|NODE_OPTIONS|NODE_PATH|ELECTRON_.*|DYLD_.*|LD_.*|WORKROOM_.*|GIT_CONFIG.*|PYTHON.*|npm_config_.*)$/i;
export function validateEnvironmentNames(raw: unknown): string[] {
  const parsed = environmentNames.safeParse(raw);
  if (!parsed.success || parsed.data.some(name => reserved.test(name)) || new Set(parsed.data.map(name => process.platform === 'win32' ? name.toUpperCase() : name)).size !== parsed.data.length) throw new Error('환경변수 이름을 확인하세요. 실행 경로·프로필·로더·앱 내부 변수는 허용할 수 없습니다.');
  return [...parsed.data].sort();
}
export function selectedEnvironment(allowed: string[], requested: string[]): Record<string, string> {
  const names = validateEnvironmentNames(requested);
  const values: Record<string, string> = Object.create(null);
  for (const name of names) {
    const match = (value: string): boolean => process.platform === 'win32' ? value.toUpperCase() === name.toUpperCase() : value === name;
    if (!allowed.some(match)) throw new Error(`WWG에서 먼저 허용해야 하는 환경변수입니다: ${name}`);
    const actualName = Object.keys(process.env).find(match);
    const value = actualName ? process.env[actualName] : undefined;
    if (value === undefined) throw new Error(`앱 실행 환경에 없는 환경변수입니다: ${name}`);
    if (value.includes('\0') || Buffer.byteLength(value) > 8192) throw new Error('환경변수 값의 형식 또는 크기를 확인하세요.');
    values[name] = value;
  }
  if (Buffer.byteLength(JSON.stringify(values)) > 65536) throw new Error('선택한 환경변수의 합계가 64KiB를 초과합니다.');
  return values;
}
export function commandEnvironment(selected: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Fixed runtime settings, never inherited from the application's environment.
  return { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', NO_COLOR: '1', TERM: 'dumb', LC_CTYPE: 'en_US.UTF-8', ...selected };
}
/** Keep a raw suffix in memory so values split across stdout/stderr chunks cannot leak. */
export function outputRedactor(values: string[]): (text: string, final?: boolean) => string {
  const secrets = [...new Set(values.filter(Boolean))].sort((a,b) => b.length-a.length);
  if (!secrets.length) return text => text;
  const regex = new RegExp(secrets.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const keep = secrets[0]!.length - 1; let pending = '';
  return (text, final = false) => {
    pending += text; let end = final ? pending.length : Math.max(0, pending.length - keep);
    regex.lastIndex = 0;
    for (let match; (match = regex.exec(pending)) && match.index < end;) end = Math.max(end, match.index + match[0].length);
    const result = pending.slice(0, end).replace(regex, '[환경변수 값 숨김]'); pending = pending.slice(end); return result;
  };
}
