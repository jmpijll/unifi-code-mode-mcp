<p align="center">
  <img src="docs/assets/hero.svg" alt="UniFi Code Mode MCP. Two tools. One API." width="100%">
</p>

<p align="center">
  <strong>Explore your UniFi network through two MCP tools.</strong><br>
  Query Network, Site Manager and Protect APIs from a sandboxed JavaScript session.
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#example-session">Example session</a> ·
  <a href="#know-the-boundaries">Boundaries</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">Node.js 22.19+ · Public beta · v0.2.0-beta.1 · MIT license</p>

[![CI](https://github.com/jmpijll/unifi-code-mode-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jmpijll/unifi-code-mode-mcp/actions/workflows/ci.yml)

## Two tools, one API

This [Model Context Protocol](https://modelcontextprotocol.io/) server exposes `search` and `execute`.
The agent searches the API reference, then runs JavaScript inside a QuickJS WASM sandbox.
API calls go through the host; credentials remain outside the sandbox.

- **Search three API specs.** Network, Site Manager and Protect.
- **Choose your route.** Local controller access or cloud connector access by console ID.
- **Use the same server in both modes.** Stdio with environment credentials; HTTP with per-request tenant headers.
- **Inspect errors.** Upstream errors retain the surface and operation context.

## Get started

Install from source and point your MCP client at the built `dist/index.js`.

### Requirements

- Node.js **22.19.0 or newer** and npm. CI checks Node 22 and 24.
- A UniFi API key for your local controller or Site Manager.

### Build from source

```bash
git clone https://github.com/jmpijll/unifi-code-mode-mcp.git
cd unifi-code-mode-mcp
npm ci
cp .env.example .env
# Edit .env: UNIFI_LOCAL_BASE_URL and UNIFI_LOCAL_API_KEY, or UNIFI_CLOUD_API_KEY.
npm run build
npm start
```

The shell examples use Bash. In PowerShell, use `Copy-Item .env.example .env` and
set variables with `$env:NAME = 'value'`.

Configure your MCP client with `node /absolute/path/to/unifi-code-mode-mcp/dist/index.js`.
Use an absolute path and supply credentials through the client's environment configuration
when its working directory does not contain your `.env` file.
See the [client setup and usage guide](docs/usage.md).

For hosted use, set `MCP_TRANSPORT=http` and follow the [per-request credential contract](docs/multi-tenant.md).
Docker instructions are in [docker-compose.yml](docker-compose.yml).

## Example session

After discovering the operation with the search tool, use the execute tool:

```javascript
var sites = unifi.local.sites.listSites({ limit: 200 });
sites.data.map(function (site) { return { id: site.id, name: site.name }; });
```

See the [usage guide](docs/usage.md) for search recipes, configuration and additional call shapes.

## Know the boundaries

| Area | Current boundary |
| --- | --- |
| API coverage | Integration APIs only; legacy configuration and binary/streaming Protect operations are outside the JSON client surface. |
| Mutations | A Protect camera rename/revert was historically verified; Network mutations need further validation. |
| Workers | Scaffold; full transport parity with Node is not implemented. |
| Sandbox | Resource limits bound each invocation; allowed API calls still act with the supplied account's permissions. |

### Verification status

Earlier maintainer runs cover local/cloud Network and Protect, a camera rename/revert, and selected CLI clients. Other clients, hosted multi-tenancy and sustained-load behavior remain unverified.
See the [setup and verification reference](docs/usage.md#setup-and-verification-reference)
for the detailed historical evidence and remaining work. New verification reports should
identify the server revision, client, upstream version and operations actually exercised.

### Project status

Public beta · v0.2.0-beta.1. Install from source; the package remains private and is not published to npm.

## Privacy

The host sends API requests to the service configured for this server. Tool results and
captured sandbox logs are returned to your MCP client; that client may send them to its
configured model provider. Spec caches may be written locally.

Keep `.env` files and credentials private. Redact account identifiers, IP addresses and
service data before sharing logs or verification reports. See [SECURITY.md](SECURITY.md)
for vulnerability reporting.

## Development and contribution

```bash
npm run check
```

`check` runs lint, formatting, typecheck, mocked tests and the build.
It also verifies the built MCP server version and its two tools without tenant credentials
or upstream network access. `npm run cf:check` validates the Worker bundle without deploying it. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the repository layout and contribution checks, and [AGENTS.md](AGENTS.md) for
architectural invariants. Live API tests require separate credentials and verification scope.

## Documentation

- [Usage and client setup](docs/usage.md)
- [Architecture](docs/architecture.md)
- [Agent operating manual](SKILL.md) and [example persona](examples/unifi-expert-agent/)
- [Changelog](CHANGELOG.md)

## License and acknowledgements

[MIT](LICENSE). Built with TypeScript, the MCP SDK and QuickJS, following the
[Cloudflare Code Mode pattern](https://github.com/cloudflare/mcp-server-cloudflare).
