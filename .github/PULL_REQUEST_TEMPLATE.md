## What changed

Describe the problem and resulting behavior. Link related issues where applicable.

## Verification

- [ ] `npm run check` succeeds (lint, formatting, typecheck, mocked tests and build)
- [ ] Built MCP smoke succeeds (included in `npm run check`); no tenant credentials needed
- [ ] `npm run cf:check` succeeds if the Worker or its dependencies changed
- [ ] Relevant README, usage, contributor or agent docs updated
- [ ] Live checks, if performed, name the client, upstream version and operations exercised
- [ ] No credentials, tenant identifiers or private service data committed

## Notes for reviewers

Describe compatibility changes and remaining validation. Keep mocked, live and LLM-mediated evidence distinct.
