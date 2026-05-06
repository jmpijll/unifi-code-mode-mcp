# Security Policy

## Supported versions

Pre-1.0; security fixes target `main`.

## Reporting a vulnerability

Please **do not** open public GitHub issues for security problems. Instead, email the maintainer or open a [GitHub security advisory](https://github.com/jmpijll/unifi-code-mode-mcp/security/advisories/new).

## Threat model summary

- The QuickJS sandbox is the trust boundary between LLM-generated code and the host. The host enforces memory, CPU, time, and API-call limits.
- API keys live on the host (env or per-request HTTP headers) and **never** enter the sandbox. The sandbox can only request that the host make calls on its behalf.
- In multi-user mode, the server is stateless w.r.t. tenant credentials: each request brings its own. There is no shared cache of credentials between tenants.
- TLS verification for the local Integration API is strict by default. Operators can opt in to skipping verification per-tenant; doing so emits a loud warning in tool output.

See [docs/security.md](docs/security.md) for the full threat model.
