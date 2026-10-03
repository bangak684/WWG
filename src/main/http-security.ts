import type { ServerResponse, OutgoingHttpHeaders } from 'node:http';

/** Enforce final headers even when the MCP adapter supplies its own writeHead headers. */
export function protectResponse(res: ServerResponse): void {
  const original = res.writeHead.bind(res);
  res.writeHead = function(statusCode: number, ...rest: any[]): ServerResponse {
    const message = typeof rest[0] === 'string' ? rest[0] : undefined;
    const supplied = message === undefined ? rest[0] : rest[1];
    const headers: OutgoingHttpHeaders = {};
    const protectedNames = new Set(['cache-control','x-content-type-options','referrer-policy']);
    if (Array.isArray(supplied)) {
      for (let i=0; i<supplied.length; i+=2) if (!protectedNames.has(String(supplied[i]).toLowerCase())) headers[String(supplied[i])] = supplied[i+1];
    } else if (supplied) {
      for (const [name, value] of Object.entries(supplied as OutgoingHttpHeaders)) if (!protectedNames.has(name.toLowerCase())) headers[name] = value;
    }
    headers['Cache-Control'] = 'no-store';
    headers['X-Content-Type-Options'] = 'nosniff';
    headers['Referrer-Policy'] = 'no-referrer';
    return message === undefined ? original(statusCode, headers) : original(statusCode, message, headers);
  } as typeof res.writeHead;
}
