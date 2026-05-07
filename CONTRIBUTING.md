# Contributing to unifi-code-mode-mcp

Thanks for thinking about it. This is a public beta and we genuinely
need help — verification reports, bug reports, edge cases against real
UniFi hardware, and PRs.

## Project posture

- **Status: beta.** The package is `"private": true` in `package.json`.
  We will lift that and publish to npm when we tag `1.0.0`. Until then,
  install from source.
- **Single maintainer.** Response time is best-effort. If you don't hear
  back in a week, ping the issue.
- **Honest scope.** We say what we've verified and what we haven't —
  read the [README's Project status](README.md#project-status) before
  filing.

## Filing issues

Use the right template:

- **Bug report** — something works wrong against the documented surface.
  Use the bug report template; include the exact JS you ran in `execute`,
  the controller version (`GET /v1/info` for Network, `GET /v1/meta/info`
  for Protect), and a redacted log. Don't paste API keys.
- **Verification report** — you tested with an agent platform we haven't
  verified yet (Claude Code, Claude Desktop, VS Code Copilot, Codex CLI,
  Continue, Cline, MCP Inspector, Aider, Zed, …). This is the most
  helpful kind of issue right now. The template has a checklist.
- **Feature request** — something the API exposes that we don't. Cite
  the OpenAPI op (path + method) and explain the use case.
- **Security issue** — DO NOT open a public issue. See
  [`SECURITY.md`](SECURITY.md).

Don't open blank issues — they're disabled.

## Local dev loop

```bash
git clone https://github.com/jmpijll/unifi-code-mode-mcp.git
cd unifi-code-mode-mcp
npm install
cp .env.example .env
# Set UNIFI_LOCAL_API_KEY / UNIFI_CLOUD_API_KEY as needed.
npm run typecheck      # tsc --noEmit
npm test               # vitest run (98 specs)
npm run lint           # eslint
npm run build          # tsc + copy fallback specs
```

Quality gates that have to pass before a PR merges:

- `npm run lint` — clean
- `npm run typecheck` — clean
- `npm test` — 98/98 (or more, with your additions)
- `npm run build` — clean

We tolerate `npm run format:check` warnings on pre-existing files (the
codebase has some Prettier drift we haven't combed out); please don't
"fix" them in the same PR as a feature change — keep diffs focused.

## What good PRs look like

- One concern per PR. If it's "feature + drive-by-cleanup", split.
- New behaviour comes with tests. The test file lives next to the
  system under test (see `src/__tests__/`).
- Public-facing changes update the right doc:
  - `SKILL.md` if it changes the agent's operating manual
  - `AGENTS.md` if it changes how contributors should think about the
    architecture
  - `README.md` if it changes the verified-status table or roadmap
  - `CHANGELOG.md` under `[Unreleased]`
- Commit messages: imperative subject, body explains *why*. We squash-
  merge by default so the merge commit becomes the "what changed" line.

## What stays out of source

- API keys, controller fingerprints, MAC addresses, IPs, snapshots
  containing real device names. The `.gitignore` covers `out/` (the
  scratch dir that scripts write to) and `out/verification/` is the only
  gitignored exception — we keep curated, sanitized verification
  artefacts there.
- `.cursor/`, `.opencode/`, `.claude/`, etc. local agent configs. Use
  the project-scoped configs at the repo root (`.cursor/mcp.json`,
  `opencode.json`) which ARE in source.

## Code style

See `AGENTS.md` § 7 for the code-style cheat sheet. The big ones:

- TypeScript strict, ESM, Node 20+.
- Avoid narrative comments — explain *why* of non-obvious decisions only.
- Errors crossing the sandbox boundary go through the `formatXError`
  helpers and preserve the `[unifi.<surface>.<error-class>]` prefix.

## Code of conduct

Be kind. Don't harass anyone. If you're abusive in issues or PRs we'll
block you and move on. We don't have a formal Contributor Covenant
because we're one person; if the project grows we'll adopt one.

## Licensing

By contributing, you agree your contribution is licensed under the same
[MIT license](LICENSE) as the rest of the project.
