# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial scaffold: code-mode MCP server with `search` + `execute` tools
- UniFi Network Integration API support via dynamic OpenAPI loading
- UniFi Site Manager (cloud) API support (curated fallback OpenAPI)
- **Cloud → Network proxy surface**: `unifi.cloud.network(consoleId).<tag>.<op>(...)` tunnels Network Integration calls through `api.ui.com/v1/connector/consoles/{id}/proxy/network/integration` using the Site Manager API key. No need to expose the controller publicly.
- `createCloudNetworkProxyClient(creds, consoleId)` host factory and host bindings `__unifiCallCloudNetwork` / `__unifiRawCloudNetwork`
- Single-user (env) and multi-user (per-request HTTP headers) modes
- Stdio + Streamable HTTP transports
- Cloudflare Workers entry point
- Live test script (`scripts/live-test.ts`) probes local, cloud-native, and cloud-proxy paths independently with 1Password CLI integration

### Roadmap
- `unifi.cloud.protect(consoleId).*` over the Protect connector path
- Per-tenant rate limiting
