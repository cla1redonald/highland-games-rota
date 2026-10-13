/**
 * A thin Streamable HTTP transport for the same server: the same tools, the same schemas, the same service. Added for
 * hosted agents that connect to MCP servers by URL.
 *
 *   - It binds to the loopback interface only. Making it reachable from elsewhere is a deliberate act outside this
 *     code (a tunnel to the local port), never a flag here.
 *   - Every request needs the bearer token it was started with, compared in constant time. No token, no server.
 *   - Stateless: each POST gets a fresh server and transport, so one client's state never reaches another.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { RotaService } from '@ghillie/engine';
import { createRotaServer } from './server.js';

export interface HttpServerOptions {
  service: RotaService;
  token: string;
  /** 0 picks a free port. */
  port?: number;
  host?: '127.0.0.1' | '::1' | 'localhost';
  /** Largest request body accepted, in bytes. */
  maxBodyBytes?: number;
}

export interface RunningHttpServer {
  url: string;
  close: () => Promise<void>;
}

const loopback = new Set(['127.0.0.1', '::1', 'localhost']);

function authorised(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new Error('request too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const host = options.host ?? '127.0.0.1';
  if (!loopback.has(host)) throw new Error(`refusing to bind to ${String(host)}: loopback only`);
  if (options.token.length < 24) throw new Error('refusing to start without a bearer token of at least 24 characters');
  const limit = options.maxBodyBytes ?? 1_000_000;

  const http = createServer((req, res) => {
    void (async (): Promise<void> => {
      if (!authorised(req, options.token)) return refuse(res, 401, 'unauthorised');
      if ((req.url ?? '').split('?')[0] !== '/mcp') return refuse(res, 404, 'not found');
      if (req.method !== 'POST') return refuse(res, 405, 'method not allowed');
      let body: unknown;
      try {
        body = await readBody(req, limit);
      } catch (error) {
        return refuse(res, 400, error instanceof Error ? error.message : 'bad request');
      }
      const server = createRotaServer({ service: options.service });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) refuse(res, 500, 'internal error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, host, () => resolve());
  });
  const address = http.address() as AddressInfo;
  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${shown}:${address.port}/mcp`,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
