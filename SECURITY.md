# Security policy

## Supported versions

This project is in public **beta**. Only the latest tagged version
(currently `v0.2.0-beta.1`) receives security fixes.

| Version | Supported |
|---|---|
| `0.2.0-beta.x` | yes |
| `0.1.x` and earlier | no |

When `1.0.0` ships, we'll narrow this to "current minor + previous minor".

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Use GitHub's private security advisories:

1. Go to https://github.com/jmpijll/unifi-code-mode-mcp/security/advisories
2. Click **"Report a vulnerability"**
3. Fill in the form

Include:

- A description of the vulnerability and its impact
- Steps to reproduce (or a PoC)
- Affected commit / tag
- Suggested fix if you have one

We aim to acknowledge within 7 days and have a fix or mitigation within
30 days for confirmed issues. We'll coordinate disclosure with you.

## Scope

In scope:

- The MCP server (stdio + Streamable HTTP transports)
- The QuickJS sandbox host bridge (escape paths, header smuggling,
  prototype pollution between sandbox and host, secret leakage)
- The credential-resolution path (env vs HTTP headers)
- TLS handling, including any `UNIFI_*_TLS_INSECURE` overrides
- The Cloudflare Workers entry (`src/cloudflare/worker.ts`)
- The OpenAPI spec loader and its caching/network behaviour
- Anything in the published source that could mishandle a customer's
  UniFi controller credentials

Out of scope (please report to Ubiquiti, not us):

- Vulnerabilities in the UniFi API itself
- Vulnerabilities in upstream dependencies — file those upstream and
  we'll bump
- Issues that require physical access to a victim's UniFi hardware
- Self-XSS in agent UIs that we don't ship

## Secrets in this repo

If you find a leaked secret in any commit (current or historical),
report it via the security advisory channel above. We will rotate, force-
push if absolutely necessary, and document the incident in
`CHANGELOG.md`.

## Threat model summary

- The QuickJS sandbox is the trust boundary between LLM-generated code
  and the host. The host enforces memory, CPU, time, and API-call
  limits. Sandbox-to-host calls are namespaced and never expose raw
  credentials.
- API keys live on the host (env or per-request HTTP headers) and
  **never** enter the sandbox. The sandbox can only request that the
  host make calls on its behalf.
- In multi-user mode, the server is stateless w.r.t. tenant
  credentials: each request brings its own. There is no shared cache of
  credentials between tenants.
- TLS verification for the local Integration API is strict by default.
  Operators can opt in to skipping verification per-tenant; doing so
  emits a loud warning in tool output.

See [`docs/security.md`](docs/security.md) for the full threat model.

## Hall of fame

Once we have one. Until then: thank you in advance.
