# Contributing

## Development

Use Node.js 22 or 24 and create changes from a feature branch.

```bash
npm ci
npm run check
```

Tests must use synthetic or redacted fixtures and must not contact a real Yuque account. Do not commit cookies, tokens, phone numbers, verification codes, document bodies, HAR files, screenshots, private hosts, internal deployment names, or research captures.

## Endpoint evidence

A new or changed write capability is accepted only when its contract records static front-end evidence, an observed browser request, replay after the browser is closed, error behavior, idempotency/retry policy, and write-back verification. Unknown request fields, DELETE semantics, or response shapes must fail closed. Keep raw captures outside the repository and delete them after extracting a redacted contract.

## Pull requests

- Keep MCP tools typed and update the capability registry, instructions, README, contract tests, and tool-count assertion together.
- Add unit tests for validation, conflict, timeout, and sensitive-data boundaries.
- Preserve one-owner isolation and the default `strict` mode.
- Do not introduce arbitrary URL, raw HTTP, cookie export, or TLS-disable features.
- Run formatting, type checking, coverage, build, public-content scanning, and dependency audit.

Real-account verification belongs in a separately controlled sandbox. Its evidence may be summarized in a release decision, but account identifiers and raw traffic do not belong in a public pull request.
