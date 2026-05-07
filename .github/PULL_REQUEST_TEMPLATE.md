<!--
Thanks for the PR. Keep diffs focused — one concern per PR. Pre-existing
Prettier drift on untouched lines is fine to leave alone.
-->

## What

<!-- One paragraph: what does this PR do? -->

## Why

<!-- Why is this needed? Cite an issue if there is one. -->

Closes #

## How

<!-- Implementation notes a reviewer needs. Surface(s) touched, files
that are load-bearing for the change. -->

## Verification

<!-- How did you verify this works? Mark all that apply. -->

- [ ] `npm run lint` clean
- [ ] `npm run typecheck` clean
- [ ] `npm test` — `__/__` passing (fill in totals)
- [ ] `npm run build` clean
- [ ] Added / updated unit tests (in `src/__tests__/`)
- [ ] Tested live against a real UniFi controller (cite controller version)
- [ ] Tested via an LLM-mediated agent (cite agent + model)
- [ ] Updated `SKILL.md` (if surface changed)
- [ ] Updated `AGENTS.md` (if architecture / contributor flow changed)
- [ ] Updated `README.md` (if verification matrix or roadmap changed)
- [ ] Added entry under `[Unreleased]` in `CHANGELOG.md`

## Risk / blast radius

<!-- What breaks if this is wrong? Anything that needs a follow-up
verification report from a tester? -->

## Out of scope

<!-- Things this PR does NOT do, that a reviewer might wonder about. -->
