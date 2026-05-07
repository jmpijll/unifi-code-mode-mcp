/**
 * Mock UniFi controller for integration tests.
 *
 * Speaks just enough of the Network Integration v1 surface to exercise the
 * MCP server end-to-end. Records every request so tests can assert which
 * operations were called and with which bodies.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CLIENTS_PAGE,
  DEVICES_PAGE,
  FIREWALL_ZONES_LEGACY_ERROR,
  INFO,
  NETWORKS_PAGE,
  PROTECT_CAMERAS_PAGE,
  PROTECT_CAMERA_FRONT,
  PROTECT_CAMERA_FRONT_ID,
  PROTECT_META_INFO,
  PROTECT_NVRS_PAGE,
  SITES_PAGE,
  SITE_ID,
  WANS_PAGE,
  WIFI_HOME_DETAILS,
  WIFI_HOME_ID,
  WIFI_PAGE,
} from './fixtures/unifi-canned.js';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface MockController {
  baseUrl: string;
  requests: RecordedRequest[];
  reset(): void;
  close(): Promise<void>;
}

export async function startMockController(opts: { apiKey: string }): Promise<MockController> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void handle(req, res, opts.apiKey, requests);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(addr.port)}`;

  return {
    baseUrl,
    requests,
    reset() {
      requests.length = 0;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  expectedApiKey: string,
  requests: RecordedRequest[],
): Promise<void> {
  const body = await readBody(req);
  const path = req.url ?? '/';
  const method = req.method ?? 'GET';
  requests.push({ method, path, headers: { ...req.headers }, body });

  if (req.headers['x-api-key'] !== expectedApiKey) {
    json(res, 401, {
      code: 'api.auth.invalid-key',
      message: 'Missing or invalid X-API-Key',
    });
    return;
  }

  // The MCP host calls either /proxy/network/integration/<...> (Network)
  // or /proxy/protect/integration/<...> (Protect); route accordingly.
  if (path.startsWith('/proxy/protect/integration')) {
    handleProtect(method, path.slice('/proxy/protect/integration'.length), body, res);
    return;
  }

  const apiPath = path.startsWith('/proxy/network/integration')
    ? path.slice('/proxy/network/integration'.length)
    : path;
  const route = `${method} ${stripQuery(apiPath)}`;

  switch (route) {
    case `GET /v1/info`:
      json(res, 200, INFO);
      return;
    case `GET /v1/sites`:
      json(res, 200, SITES_PAGE);
      return;
    case `GET /v1/sites/${SITE_ID}/devices`:
      json(res, 200, DEVICES_PAGE);
      return;
    case `GET /v1/sites/${SITE_ID}/networks`:
      json(res, 200, NETWORKS_PAGE);
      return;
    case `GET /v1/sites/${SITE_ID}/wans`:
      json(res, 200, WANS_PAGE);
      return;
    case `GET /v1/sites/${SITE_ID}/wifi/broadcasts`:
      json(res, 200, WIFI_PAGE);
      return;
    case `GET /v1/sites/${SITE_ID}/wifi/broadcasts/${WIFI_HOME_ID}`:
      json(res, 200, WIFI_HOME_DETAILS);
      return;
    case `PUT /v1/sites/${SITE_ID}/wifi/broadcasts/${WIFI_HOME_ID}`:
      json(res, 200, {
        ...WIFI_HOME_DETAILS,
        ...((body ?? {}) as Record<string, unknown>),
      });
      return;
    case `GET /v1/sites/${SITE_ID}/firewall/zones`:
      json(res, FIREWALL_ZONES_LEGACY_ERROR.status, FIREWALL_ZONES_LEGACY_ERROR.body);
      return;
    case `GET /v1/sites/${SITE_ID}/clients`:
      json(res, 200, CLIENTS_PAGE);
      return;
    default:
      json(res, 404, {
        code: 'api.notfound',
        message: `No mock route for ${method} ${apiPath}`,
      });
  }
}

function handleProtect(
  method: string,
  apiPath: string,
  body: unknown,
  res: ServerResponse,
): void {
  const route = `${method} ${stripQuery(apiPath)}`;
  switch (route) {
    case 'GET /v1/meta/info':
      json(res, 200, PROTECT_META_INFO);
      return;
    case 'GET /v1/cameras':
      json(res, 200, PROTECT_CAMERAS_PAGE);
      return;
    case `GET /v1/cameras/${PROTECT_CAMERA_FRONT_ID}`:
      json(res, 200, PROTECT_CAMERA_FRONT);
      return;
    case 'GET /v1/nvrs':
      json(res, 200, PROTECT_NVRS_PAGE);
      return;
    case `POST /v1/cameras/${PROTECT_CAMERA_FRONT_ID}/ptz/goto/1`:
      void body; // accept any body shape
      res.writeHead(204);
      res.end();
      return;
    default:
      json(res, 404, {
        code: 'api.notfound',
        message: `No mock Protect route for ${method} ${apiPath}`,
      });
  }
}

function stripQuery(path: string): string {
  const i = path.indexOf('?');
  return i === -1 ? path : path.slice(0, i);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const text = Buffer.concat(chunks).toString('utf-8');
      try {
        resolve(text.length > 0 ? JSON.parse(text) : undefined);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
