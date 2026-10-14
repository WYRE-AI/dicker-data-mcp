/**
 * HTTP transport fail-closed auth.
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders never count. /mcp rejects a missing or invalid
 * X-Gateway-S2S header. AUTH_MODE=gateway rejects requests that omit
 * x-dickerdata-account-code or x-dickerdata-access-token and must not fall
 * back to DICKERDATA_* in process.env.
 */

import { createHmac } from 'node:crypto';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHttpServer } from '../http.js';

const S2S_SECRET = 's2s-do-not-log-7f3a';
const ENV_ACCOUNT = 'env-account-must-not-be-used';
const ENV_TOKEN = 'env-token-must-not-be-used';
const HEADER_ACCOUNT = 'header-account-code';
const HEADER_TOKEN = 'header-access-token';
const PLACEHOLDER = 'replace-with-a-real-secret';

const ENV_KEYS = [
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'MCP_HTTP_PORT',
  'MCP_HTTP_HOST',
  'AUTH_MODE',
  'DICKERDATA_ACCOUNT_CODE',
  'DICKERDATA_ACCESS_TOKEN',
  'LOG_LEVEL',
  'MCP_TRANSPORT',
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
  return {
    text: () => lines.join('\n'),
    restore: () => spy.mockRestore(),
  };
}

interface HttpResult {
  status: number;
  body: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error(`timeout ${options.method} ${options.path}`));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function listen(): Promise<{ port: number; address: string; server: Server }> {
  const server = await startHttpServer();
  servers.push(server);
  const bound = server.address() as AddressInfo | null;
  if (!bound || typeof bound === 'string') {
    throw new Error('HTTP server did not bind a TCP port');
  }
  return { port: bound.port, address: bound.address, server };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

const listTools = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
});

const invoiceCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'dickerdata_list_invoices', arguments: {} },
});

function mockExit() {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

function assertNoSecrets(text: string): void {
  expect(text).not.toContain(S2S_SECRET);
  expect(text).not.toContain(ENV_ACCOUNT);
  expect(text).not.toContain(ENV_TOKEN);
  expect(text).not.toContain(HEADER_ACCOUNT);
  expect(text).not.toContain(HEADER_TOKEN);
  expect(text).not.toContain(PLACEHOLDER);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = '0';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.LOG_LEVEL = 'info';
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.DICKERDATA_ACCOUNT_CODE;
  delete process.env.DICKERDATA_ACCESS_TOKEN;
  delete process.env.MCP_TRANSPORT;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('HTTP startup', () => {
  it('refuses to start when CONDUIT_S2S_SECRET is empty', async () => {
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('CONDUIT_S2S_SECRET');
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it('still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = 'true';
    process.env.CONDUIT_S2S_SECRET = '   ';
    const logs = captureStderr();
    mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain('Refusing to start HTTP transport');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it.each(['changeme', 'replace-with-a-real-secret', '  Your-S2S-Secret  '])(
    'refuses known placeholder secret %j and does not log it',
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      const logs = captureStderr();
      const exitSpy = mockExit();

      try {
        await expect(startHttpServer()).rejects.toThrow('process.exit:1');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain('known placeholder');
        expect(text).toContain('openssl rand -hex 32');
        expect(text).not.toContain(placeholder.trim());
        expect(text).not.toContain('Your-S2S-Secret');
        assertNoSecrets(text);
      } finally {
        logs.restore();
      }
    },
  );

  it('refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1', async () => {
    process.env.CONDUIT_S2S_SECRET = 'changeme';
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startHttpServer()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('known placeholder');
      expect(text).not.toContain('SECURITY WARNING');
      expect(text).not.toContain('changeme');
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it('allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      const server = await listen();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(server.address).toBe('127.0.0.1');
      const text = logs.text();
      expect(text).toContain('SECURITY WARNING');
      expect(text).toContain('CONDUIT_S2S_SECRET');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV');
      expect(text).toContain('127.0.0.1');
      expect(text).not.toContain('not a loopback address');
      assertNoSecrets(text);
    } finally {
      logs.restore();
    }
  });

  it.each(['0.0.0.0', '10.1.2.3'])(
    'overrides non-loopback MCP_HTTP_HOST=%s when the dev bypass is on',
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      const exitSpy = mockExit();

      try {
        const server = await listen();
        expect(exitSpy).not.toHaveBeenCalled();
        expect(server.address).toBe('127.0.0.1');
        const text = logs.text();
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain('Binding 127.0.0.1 only');
        assertNoSecrets(text);
      } finally {
        logs.restore();
      }
    },
  );

  it('forces 127.0.0.1 when the dev bypass host is localhost', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    process.env.MCP_HTTP_HOST = 'localhost';
    const logs = captureStderr();

    try {
      const server = await listen();
      expect(server.address).toBe('127.0.0.1');
      expect(logs.text()).toContain('SECURITY WARNING');
      expect(logs.text()).not.toContain('not a loopback address');
    } finally {
      logs.restore();
    }
  });

  it('honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const logs = captureStderr();

    try {
      const server = await listen();
      expect(server.address).toBe('0.0.0.0');
      expect(logs.text()).not.toContain('not a loopback address');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it('binds 0.0.0.0 when a secret is set and MCP_HTTP_HOST is unset', async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.address).toBe('0.0.0.0');
  });
});

describe('HTTP /mcp authentication', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    process.env.DICKERDATA_ACCOUNT_CODE = ENV_ACCOUNT;
    process.env.DICKERDATA_ACCESS_TOKEN = ENV_TOKEN;
    process.env.MCP_HTTP_HOST = '127.0.0.1';
  });

  it('returns 401 when the S2S header is missing or invalid and does not log the secret', async () => {
    const logs = captureStderr();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();
    try {
      const missing = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({
          'x-dickerdata-account-code': HEADER_ACCOUNT,
          'x-dickerdata-access-token': HEADER_TOKEN,
        }),
        body: listTools,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader('wrong-secret'),
          'x-dickerdata-account-code': HEADER_ACCOUNT,
          'x-dickerdata-access-token': HEADER_TOKEN,
        }),
        body: listTools,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain('X-Gateway-S2S');
      expect(invalid.body).toContain('X-Gateway-S2S');
      assertNoSecrets(missing.body);
      assertNoSecrets(invalid.body);
      assertNoSecrets(logs.text());
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      logs.restore();
    }
  });

  it('returns 401 in gateway mode without credential headers and does not use env credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();

    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: invoiceCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain('x-dickerdata-account-code');
    expect(response.body).toContain('x-dickerdata-access-token');
    expect(response.body).toContain('Unauthorized');
    assertNoSecrets(response.body);
    expect(fetchMock).not.toHaveBeenCalled();

    const partial = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({
        'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
        'x-dickerdata-account-code': HEADER_ACCOUNT,
      }),
      body: invoiceCall,
    });
    expect(partial.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a valid S2S header plus credential headers and uses those credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          AccessKey: 'ak-header',
          ExpireDateTime: new Date(Date.now() + 600_000).toISOString(),
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ SearchResult: [] }));

    const logs = captureStderr();
    const server = await listen();
    try {
      const response = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
          'x-dickerdata-account-code': HEADER_ACCOUNT,
          'x-dickerdata-access-token': HEADER_TOKEN,
        }),
        body: invoiceCall,
      });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalled();
      const [, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
      const posted = JSON.parse(init.body ?? '{}') as { AccountCode?: string; AccessToken?: string };
      expect(posted.AccountCode).toBe(HEADER_ACCOUNT);
      expect(posted.AccessToken).toBe(HEADER_TOKEN);
      assertNoSecrets(response.body);
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it('serves /health without authentication and without reading credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'GET',
      path: '/health',
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { status?: string; mode?: string; credentials?: unknown };
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('gateway');
    expect(body.credentials).toBeUndefined();
    assertNoSecrets(response.body);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HTTP AUTH_MODE=env', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'env';
    process.env.DICKERDATA_ACCOUNT_CODE = ENV_ACCOUNT;
    process.env.DICKERDATA_ACCESS_TOKEN = ENV_TOKEN;
    process.env.MCP_HTTP_HOST = '127.0.0.1';
  });

  it('accepts a signed request that omits vendor headers and uses env credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          AccessKey: 'ak-env',
          ExpireDateTime: new Date(Date.now() + 600_000).toISOString(),
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ SearchResult: [] }));

    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: invoiceCall,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
    const posted = JSON.parse(init.body ?? '{}') as { AccountCode?: string; AccessToken?: string };
    expect(posted.AccountCode).toBe(ENV_ACCOUNT);
    expect(posted.AccessToken).toBe(ENV_TOKEN);
    expect(response.body).not.toContain(S2S_SECRET);
  });
});
