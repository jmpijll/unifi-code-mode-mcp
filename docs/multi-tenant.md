# Multi-tenant deployment

Run the server on `MCP_TRANSPORT=http` and let each MCP client supply its own credentials per request.

## Header contract

| Header | Required for | Description |
| --- | --- | --- |
| `X-Unifi-Local-Api-Key` | `unifi.local.*` | API key minted in the controller's UniFi Network → Settings → Integrations |
| `X-Unifi-Local-Base-Url` | `unifi.local.*` | `https://<controller-host>` (no trailing path) |
| `X-Unifi-Local-Ca-Cert` | optional | PEM-encoded CA bundle to validate the controller's TLS cert |
| `X-Unifi-Local-Insecure` | optional | `true` to skip TLS verification entirely (warns) |
| `X-Unifi-Cloud-Api-Key` | `unifi.cloud.*` | API key for `https://api.ui.com` |
| `X-Unifi-Cloud-Base-Url` | optional | Override the cloud base URL (default `https://api.ui.com`) |

If a namespace's required headers are absent, calls into that namespace produce a `MissingCredentialsError` *inside the sandbox* — the LLM sees a clear, actionable message and can react.

`unifi.cloud.network(consoleId).*` uses the **cloud** API key only. The local headers are unused for that surface, so a deployment that only has the Site Manager key still gets the full Network Integration API (proxied through `api.ui.com`).

## Example MCP client request

```http
POST /mcp HTTP/1.1
Host: unifi-mcp.example.com
Content-Type: application/json
Mcp-Session-Id: 4f9c...

X-Unifi-Local-Api-Key: vNXXXXXXXX
X-Unifi-Local-Base-Url: https://192.168.1.1
X-Unifi-Local-Insecure: true
X-Unifi-Cloud-Api-Key: api-XXX

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "execute",
    "arguments": {
      "code": "var sites = unifi.local.sites.listSites({limit: 200}); sites.data.length"
    }
  }
}
```

## Single-user fallback

If headers are absent for a namespace, the server falls back to environment variables (`UNIFI_LOCAL_API_KEY`, `UNIFI_LOCAL_BASE_URL`, etc.). This makes a multi-user deployment double as a private homelab tool when no client headers are sent.

## Rate limiting

The HTTP transport applies a simple per-IP rate limit (default 60 req/min). Set `MCP_HTTP_ALLOWED_ORIGINS` to lock down the allowed `Origin` header.

## TLS for local controllers

UniFi controllers usually present a self-signed certificate. Three options:

1. **Recommended:** mint a CA-signed cert (e.g. via Let's Encrypt + DNS challenge). Verification works out of the box.
2. **Custom CA bundle:** provide your homelab CA via `X-Unifi-Local-Ca-Cert` (PEM, can be multi-line; the SDK passes it through to `undici`'s `Agent.connect.ca`).
3. **Insecure (last resort):** `X-Unifi-Local-Insecure: true` skips TLS verification. Each request emits a warning that surfaces in tool output.

## Operating recommendations

- Front the server with a reverse proxy (Caddy / nginx / Traefik) terminating TLS.
- Restrict the listener to localhost (or a service mesh) in single-host deployments.
- Audit credentials at the proxy: log header presence, NOT values.
- Rotate API keys regularly. The server holds keys only for the duration of a single request.
