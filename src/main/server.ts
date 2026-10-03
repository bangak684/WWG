import { protectResponse } from "./http-security";
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcp, workspaceInvoker } from './tools';
import { atomicPrivateWrite, readPrivateText } from './private-io';
import type { Workspace } from './service';

const MAX_BODY = 1024 * 1024;
export async function startServer(workspace: Workspace, requestedPort = 47831): Promise<{ close: () => Promise<void>; connectionFile: string }> {
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('유효한 MCP 포트를 지정하세요.');
  const connectionFile = path.join(workspace.dataDir, 'connection.json');
  const token = randomBytes(32).toString('hex');
  const tokenBytes = Buffer.from(token);
  const invoke = workspaceInvoker(workspace);
  const mcp = createMcpHandler(() => buildMcp(invoke), { responseMode: 'json', maxRequestBodySize: MAX_BODY });
  const adapter = toNodeHandler(mcp);
  let port = requestedPort; let inflight = 0;
  const reply = (res: http.ServerResponse, code: number, body: unknown): void => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    protectResponse(res);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const host = req.headers.host ?? '';
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host) || Object.hasOwn(req.headers, 'origin')) {
      reply(res, 403, { error: 'Forbidden origin or host' }); return;
    }
    const pathname = (req.url ?? '').split('?')[0]!;
    // Official tunnel discovery expects absence of OAuth metadata, not an auth challenge.
    if (req.method === 'GET' && /^\/\.well-known\/(oauth-protected-resource|oauth-authorization-server)(\/|$)/.test(pathname)) {
      reply(res, 404, { error: 'Not found' }); return;
    }
    const candidate = pathname.split('/')[1] ?? '';
    if (!/^[a-f0-9]{64}$/.test(candidate) || !timingSafeEqual(Buffer.from(candidate), tokenBytes)) {
      reply(res, 401, { error: 'Unauthorized' }); return;
    }
    if (!['GET','POST','DELETE'].includes(req.method ?? '')) { reply(res, 405, { error: 'Method not allowed' }); return; }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { reply(res, 413, { error: 'Request too large' }); return; }
    if (inflight >= 16) { reply(res, 429, { error: 'Too many requests' }); return; }
    inflight++;
    let released = false;
    const release = (): void => { if (!released) { released = true; inflight--; } };
    res.once('close', release); res.once('finish', release);
    if (pathname === `/${token}/mcp`) {
      void Promise.resolve().then(() => adapter(req, res)).catch(() => reply(res, 500, { error: 'MCP transport error' }));
      return;
    }
    reply(res,404,{error:'Not found'});
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxConnections = 64; server.maxRequestsPerSocket = 100;
  server.setTimeout(35000, socket => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(requestedPort, '127.0.0.1', resolve); });
    port = (server.address() as { port: number }).port;
    workspace.endpoint = `http://127.0.0.1:${port}/${token}/mcp`;
    await atomicPrivateWrite(connectionFile, JSON.stringify({ endpoint: workspace.endpoint }));
  } catch (err) {
    workspace.endpoint = null; server.closeAllConnections(); server.close(); await mcp.close(); throw err;
  }
  const endpoint = workspace.endpoint;
  let closing: Promise<void> | undefined;
  workspace.changed();
  return { connectionFile, close: () => {
    if (closing) return closing;
    workspace.endpoint = null; workspace.changed(); server.closeAllConnections();
    closing = (async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await mcp.close();
      try { if (JSON.parse(await readPrivateText(connectionFile, 4096)).endpoint === endpoint) await fs.unlink(connectionFile); } catch {}
    })();
    return closing;
  } };
}
