# Changelog

All notable changes are documented here. The project follows Semantic Versioning after `1.0.0`.

## Unreleased

## 1.0.0 - 2026-08-16

- Add production readiness, protected metrics, structured logging, request IDs, concurrency limits, graceful shutdown, runtime locking, outbound proxy/custom CA support, and a global write kill switch.
- Add isolated instance creation, status, backup, and rollback-aware upgrade commands.
- Add offline doctor, backup, restore, bearer rotation, and encryption-key rotation commands.
- Add the `yuque-workspace` Skill, reusable prompt templates, security policy, threat model, operations guide, and release automation.
- Add verified personal-space knowledge-base, catalog, comment, version, Doc/Sheet create/update/delete, collaborator, conflict, snapshot, and write-back contracts represented by the capability registry.
- Harden Yuque Host and exact write-allowlist validation, reject implicit `latest` images and unsafe instance HTTP URLs, and align each non-root container UID/GID with its private bind-mounted data directory.
- Add an optional read-only Soak diagnostic with cycle-density and maximum-gap evidence, pin the Node base image by digest, run a real non-root container/data-volume smoke test in CI, and scan release images before publication.
- Explicitly enable Playwright's `chromiumSandbox` option and verify a real login browser under the shipped seccomp profile; merely omitting sandbox-disabling flags from application arguments is not treated as evidence.
- Promote the 36-tool release candidate after 446 real Doc/Sheet read cycles with zero failures; long-running session expiry is recovered through the existing per-employee relogin flow rather than treated as a release blocker.

## 1.0.0-rc.1

- Feature-complete v1 release candidate with 36 MCP tools.

## 0.6.0

- Introduce one-employee-per-instance Docker Compose management.

## 0.5.0

- Add guarded Doc and Sheet best-effort write, remote lock checks, timeout reconciliation, and complete encrypted Sheet snapshots.

## 0.4.0

- Add common personal-space CRUD contracts, comments, document versions, collaborators, and typed object-deletion Preview tools.

## 0.3.0

- Add capability registry, single-owner authentication, structured Preview/Confirm, encrypted snapshots, and personal-space safety gates.
