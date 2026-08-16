# Security policy

## Supported versions

Security fixes are provided for the latest tagged minor release. Deploy immutable image tags or digests; `latest` is intentionally unsupported.

## Report a vulnerability

Do not open a public issue containing credentials, cookies, private document content, exploit details, or account identifiers. Use GitHub's private vulnerability reporting for this repository. Include the affected version, deployment shape, reproduction steps, impact, and whether the behavior reaches an unverified Yuque endpoint.

## Deployment baseline

- Run one instance per employee with independent data, bearer token, encryption key, SQLite file, port, and Compose project.
- Put remote instances behind HTTPS. Plain HTTP on a non-loopback public URL is rejected unless the deployment owner explicitly sets `ALLOW_INSECURE_HTTP=true`.
- Keep `WRITE_CONSISTENCY_MODE=strict`, deletion and permission changes disabled, and the write allowlist empty until the deployment owner completes a sandbox review.
- Use `WRITE_KILL_SWITCH=true` to stop all Confirm operations during an incident or contract regression.
- Store secrets in owner-only files or Docker secrets. Never commit runtime data, environment files, backups, screenshots, HAR files, cookies, or tokens.
- Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`. Configure `YUQUE_CA_FILE` for a trusted private CA.
- Protect `/metrics` with the same instance bearer token and restrict it at the reverse proxy.
- Treat backups and key-rotation recovery directories as secrets. Test restore before relying on them.
- Keep Chromium sandboxed. Use the shipped `deploy/chromium-seccomp.json` together with a non-root user, a read-only root filesystem, `cap_drop=ALL`, and `no-new-privileges`. Do not add `--no-sandbox`, `--disable-setuid-sandbox`, or `seccomp=unconfined`.

The Chromium profile is derived from Playwright `v1.62.1` commit `26a9e470a7b3c7822084b09fb7f13902c5f37b51`. The upstream file SHA-256 is `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`; this repository's derived profile additionally permits unconditional `chroot` for Chromium's user-namespace sandbox under `cap_drop=ALL` and has SHA-256 `b3995c4964bc2e3e7e87f38df281e5ad8cd8bfb76c6b31b65dea159d46cf1fdb`. A replacement profile requires the same default-deny property, explicit sandbox syscall review, and a real constrained-container browser launch test.

Release and scheduled Trivy jobs block every HIGH or CRITICAL finding for which an upstream fixed version exists (`ignore-unfixed: true`). This is an actionable patch gate, not a claim that the base operating system has no reported vulnerabilities. Operators should also review the complete unfiltered report, rebuild when upstream packages are fixed, and record any accepted unfixed findings in their deployment risk register.

## Trust boundaries

The MCP client may propose operations but cannot bypass Preview/Confirm, capability contracts, exact-path deletion confirmation, configuration gates, or the single-owner boundary. The deployment operator controls the host, image, secrets, write mode, allowlist, and network exposure. Yuque's web endpoints remain an external, versioned dependency and may change without notice.

See [THREAT_MODEL.md](THREAT_MODEL.md) for the detailed model.
