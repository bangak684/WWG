import path from 'node:path';

// One path policy for file tools, project roots and the OS command sandbox.
export const PROTECTED_NAMES = ['.git', '.ssh', '.codex', '.aws', '.azure', '.docker', '.gnupg', '.kube', '.config', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.vault-token', 'credentials', 'credentials.json', 'credentials.yaml', 'credentials.yml', 'credentials.toml', 'secrets', 'secrets.json', 'secrets.yaml', 'secrets.yml', 'secrets.toml', 'service-account.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'keychains', 'keyrings'];
export const PROTECTED_PREFIXES = ['.env', '.secret', '.workroom-'];
export const PROTECTED_EXTENSIONS = ['.pem', '.key', '.p8', '.p12', '.pfx', '.jks', '.keystore', '.keychain', '.keychain-db', '.kdbx'];
export function protectedName(name: string): boolean {
  const lower = name.toLowerCase();
  return PROTECTED_NAMES.includes(lower) || PROTECTED_PREFIXES.some(p => lower.startsWith(p)) || PROTECTED_EXTENSIONS.some(e => lower.endsWith(e));
}
export function protectedPath(value: string): boolean { return value.split(/[\\/]/).some(protectedName); }
export function requireSafeRoot(root: string): void {
  if (protectedPath(path.resolve(root))) throw new Error('비밀정보 또는 보호 경로는 프로젝트로 사용할 수 없습니다.');
}
const insensitive = (value: string): string => [...value].map(c => /[a-z]/.test(c) ? `[${c}${c.toUpperCase()}]` : c === '.' ? '[.]' : c).join('');
// Seatbelt regex does not support JavaScript flags. Use explicit ASCII case pairs.
export const protectedPathPatterns = [
  ...PROTECTED_NAMES.map(insensitive),
  ...PROTECTED_PREFIXES.map(p => insensitive(p) + '[^/]*'),
  ...PROTECTED_EXTENSIONS.map(e => '[^/]*' + insensitive(e))
].map(pattern => '(^|/)(' + pattern + ')(/|$)');
