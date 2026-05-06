# Deployment

## Local (stdio, single-user)

```bash
git clone https://github.com/jmpijll/unifi-code-mode-mcp.git
cd unifi-code-mode-mcp
npm install
cp .env.example .env
# Edit .env: set UNIFI_LOCAL_BASE_URL and UNIFI_LOCAL_API_KEY
npm run build
npm start
```

MCP client config:

```json
{
  "mcpServers": {
    "unifi": {
      "command": "node",
      "args": ["/abs/path/to/unifi-code-mode-mcp/dist/index.js"],
      "env": {
        "UNIFI_LOCAL_BASE_URL": "https://192.168.1.1",
        "UNIFI_LOCAL_API_KEY": "...",
        "UNIFI_LOCAL_INSECURE": "true"
      }
    }
  }
}
```

## Docker (HTTP, multi-user)

```bash
docker compose up -d
```

The default `docker-compose.yml` exposes port 8000 with no embedded credentials — clients must supply `X-Unifi-*` headers per request. To run as single-tenant, set the `UNIFI_*` env vars in `.env`.

## Cloudflare Workers

See [`cf-worker/README.md`](../cf-worker/README.md). The Workers entry is a scaffold — see the README for current status. Deploy with:

```bash
npm run cf:deploy
```

## systemd unit (Linux, HTTP)

```ini
[Unit]
Description=UniFi Code-Mode MCP Server
After=network-online.target

[Service]
Type=simple
User=mcp
WorkingDirectory=/opt/unifi-code-mode-mcp
EnvironmentFile=/opt/unifi-code-mode-mcp/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Reverse proxy (recommended for HTTP)

Caddy:

```caddyfile
unifi-mcp.example.com {
  reverse_proxy localhost:8000
}
```

The MCP transport speaks Streamable HTTP — keep a reasonable `proxy_read_timeout` (>= 60 s) for long-running tool executions.

## Health check

`GET /health` returns server status, request stats, and uptime.
