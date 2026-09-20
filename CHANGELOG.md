# Changelog

All notable changes are documented here. The project follows Semantic Versioning after `1.0.0`.

## Unreleased

- Publish the standalone Table archive experiment under `experiments/table-archive/`, with portable MCP imports, a read-only private-plan initializer, configurable text/owner field names, and setup/recovery documentation. Writes require explicit opt-in, best_effort, a disabled kill switch and an exact book allowlist; response evidence is encrypted. Fifteen offline tests cover core state transitions, the MCP adapter, policy changes, plan initialization and stdio startup outside the checkout. The main HTTP MCP tool list remains unchanged.

- Add read-only organization Table/laketable records through `yuque_get_table`, including pagination and option/user display values. Existing `yuque_get_doc` calls automatically route Table resources to record reading instead of presenting schema as document text. Web view filters and row descriptions are not applied; native Table export remains unsupported.

- Enable organization-host live write for Doc content edit (append/replace_section/delete_section/rename) and Doc creation, gated by Yuque account permissions via the new `YUQUE_WRITE_ORGANIZATION_OPEN` flag. Organization Host writes skip the exact per-book allowlist and rely on the Yuque account's own permissions; personal Host writes still require the exact allowlist. Also enables organization Host for the doc lock (`get_doc_lock`/`acquire_doc_lock`/`release_doc_lock`) and editor readback (`get_doc_editor`) contracts that the write-confirm path depends on.

## 1.2.0 - 2026-08-18

- Add `yuque_get_export_options` so agents can show the exact target path, detect Doc versus LakeSheet, and let the user choose only formats verified for that type.
- Extend native export links to personal and organization Hosts, add Excel/LakeSheet formats, and follow the pinned Yuque frontend's five-second polling workflow for non-terminal export states.
- Continue returning links without downloading or persisting files, with fail-closed delivery Host, path, query, and signature validation.

## 1.1.0 - 2026-08-17

- Add the verified `yuque_create_export_link` tool for native Word, Markdown, PDF, Lake, and JPG document exports. It returns Yuque-generated URLs without downloading or persisting export files and validates delivery Hosts, paths, query contracts, and signature expiry.

## 1.0.0 - 2026-08-16

- Add production readiness, protected metrics, structured logging, request IDs, concurrency limits, graceful shutdown, runtime locking, outbound proxy/custom CA support, and a global write kill switch.
- Add isolated instance creation, status, backup, and rollback-aware upgrade commands.
- Add offline doctor, backup, restore, bearer rotation, and encryption-key rotation commands.
- Add the `yuque-workspace` Skill, reusable prompt templates, security policy, threat model, operations guide, and release automation.
- Add verified personal-space knowledge-base, catalog, comment, version, Doc/Sheet create/update/delete, collaborator, conflict, snapshot, and write-back contracts represented by the capability registry.
- Harden Yuque Host and exact write-allowlist validation, reject implicit `latest` images and unsafe instance HTTP URLs, and align each non-root container UID/GID with its private bind-mounted data directory.
- Add an optional read-only Soak diagnostic with cycle-density and maximum-gap evidence, pin the Node base image by digest, run a real non-root container/data-volume smoke test in CI, and scan release images before publication.
- Explicitly enable Playwright's `chromiumSandbox` option and verify a real login browser under the shipped seccomp profile; merely omitting sandbox-disabling flags from application arguments is not treated as evidence.
- Promote the 36-tool release candidate after 446 real Doc/Sheet read cycles with zero failures; long-running session expiry is recovered through the existing per-user relogin flow rather than treated as a release blocker.

## 1.0.0-rc.1

- Feature-complete v1 release candidate with 36 MCP tools.

## 0.6.0

- Introduce one-user-per-instance Docker Compose management.

## 0.5.0

- Add guarded Doc and Sheet best-effort write, remote lock checks, timeout reconciliation, and complete encrypted Sheet snapshots.

## 0.4.0

- Add common personal-space CRUD contracts, comments, document versions, collaborators, and typed object-deletion Preview tools.

## 0.3.0

- Add capability registry, single-owner authentication, structured Preview/Confirm, encrypted snapshots, and personal-space safety gates.
