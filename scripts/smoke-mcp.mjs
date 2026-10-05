import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = join(root, 'dist/index.js');
assert.ok(existsSync(entry), 'dist/index.js is missing; run npm run build first');
const expectedTools = process.argv.slice(2).sort();
assert.equal(expectedTools.length, 2, 'Pass the two expected tool names');
const packageInfo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const cache = mkdtempSync(join(tmpdir(), 'code-mode-smoke-'));
const client = new Client({ name: 'code-mode-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', new URL('./smoke-network.mjs', import.meta.url).href, entry],
  cwd: root,
  // The SDK inherits only basic OS variables; API credentials and NODE_OPTIONS stay out.
  env: {
    MCP_TRANSPORT: 'stdio',
    UNIFI_SPEC_CACHE_DIR: cache,
    UNRAID_SPEC_CACHE_DIR: cache,
    MAKE_SPEC_CACHE_DIR: cache,
    SITE24X7_CACHE_DIR: cache,
  },
  stderr: 'pipe',
});
let diagnostic = '';
transport.stderr?.on('data', (chunk) => {
  diagnostic = (diagnostic + chunk.toString()).slice(-4000);
});
try {
  await client.connect(transport, { timeout: 30_000 });
  assert.deepEqual(client.getServerVersion(), {
    name: packageInfo.name,
    version: packageInfo.version,
  });
  const result = await client.listTools({}, { timeout: 30_000 });
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), expectedTools);
  console.log(
    `${packageInfo.name}: version ${packageInfo.version}; tools ${expectedTools.join(', ')}; PASS`,
  );
} catch (error) {
  if (diagnostic) console.error(diagnostic);
  throw error;
} finally {
  await client.close();
  rmSync(cache, { recursive: true, force: true });
}
