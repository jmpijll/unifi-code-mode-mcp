/**
 * Integration test harness.
 *
 * Spins up the real MCP server (createMcpServer) with the test OpenAPI
 * fixture and a mock UniFi controller, then connects an MCP Client over
 * either an in-memory transport (linked pair) or a real Streamable HTTP
 * server on a random localhost port.
 *
 * Both transport modes exercise the same server factory and tool handlers,
 * so anything that works against the in-memory transport works against
 * the HTTP transport modulo header propagation — which the HTTP scenarios
 * assert explicitly.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../../server/server.js';
import { requestStore } from '../../server/request-context.js';
import { buildOperationIndex } from '../../spec/index-builder.js';
import { buildContextFromHeaders } from '../../tenant/context.js';
import type { TenantContext } from '../../tenant/context.js';
import type { OpenApiDocument, ProcessedSpec } from '../../types/spec.js';
import type { MockController } from './mock-controller.js';
import { startMockController } from './mock-controller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const TEST_API_KEY = 'test-api-key-fixture';

export type TransportMode = 'memory' | 'http';

export interface Harness {
  client: Client;
  controller: MockController;
  cleanup(): Promise<void>;
}

export async function loadLocalFixtureSpec(): Promise<ProcessedSpec> {
  const path = resolve(__dirname, 'fixtures', 'openapi-local.json');
  const raw = await readFile(path, 'utf-8');
  const document = JSON.parse(raw) as OpenApiDocument;
  return {
    sourceUrl: 'fixture://openapi-local.json',
    version: document.info.version,
    title: document.info.title,
    serverPrefix: '',
    operations: buildOperationIndex(document),
    document,
  };
}

interface HarnessOptions {
  mode: TransportMode;
  /** Override headers passed by the MCP client (HTTP mode only). */
  headers?: Record<string, string>;
}

export async function setupHarness(opts: HarnessOptions): Promise<Harness> {
  const controller = await startMockController({ apiKey: TEST_API_KEY });
  const localSpec = await loadLocalFixtureSpec();

  if (opts.mode === 'memory') {
    const tenant: TenantContext = {
      requestId: 'test',
      fromHeaders: false,
      local: {
        baseUrl: controller.baseUrl,
        apiKey: TEST_API_KEY,
      },
    };
    const server = createMcpServer({
      localSpec,
      tenantResolver: () => tenant,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client(
      { name: 'integration-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    return {
      client,
      controller,
      async cleanup() {
        await client.close();
        await server.close();
        await controller.close();
      },
    };
  }

  // HTTP mode — full request/response path including header propagation.
  const headers: Record<string, string> = opts.headers ?? {
    'X-Unifi-Local-Api-Key': TEST_API_KEY,
    'X-Unifi-Local-Base-Url': controller.baseUrl,
  };

  const server = createMcpServer({
    localSpec,
    tenantResolver: () => {
      const ctx = requestStore.getStore();
      if (!ctx)
        throw new Error('No request context — header propagation broken in test harness');
      return buildContextFromHeaders(ctx.headers);
    },
  });
  const serverTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(serverTransport);

  const httpServer: HttpServer = createServer((req, res) => {
    void requestStore.run({ headers: req.headers, clientIp: '127.0.0.1' }, async () => {
      await serverTransport.handleRequest(req, res);
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const addr = httpServer.address() as AddressInfo;
  const url = new URL(`http://127.0.0.1:${String(addr.port)}/mcp`);

  const clientTransport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });

  const client = new Client(
    { name: 'integration-client', version: '0.0.0' },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return {
    client,
    controller,
    async cleanup() {
      await client.close();
      await serverTransport.close();
      await server.close();
      await new Promise<void>((resolve) => httpServer.close(() => { resolve(); }));
      await controller.close();
    },
  };
}

/** Helper that flattens a tool result's content into one string for assertions. */
export function toolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n---\n');
}
