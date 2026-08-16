# Threat model

## Assets

- Yuque web session cookies and CSRF token
- MCP bearer token and AES-256-GCM key
- Private document and Sheet content returned during an authorized request
- Pending change payloads, encrypted snapshots, audit summaries, and backups
- Yuque permissions and object integrity

## Boundaries

1. An employee's MCP client authenticates to one isolated instance.
2. The instance decrypts one local Yuque session and calls an allow-listed Yuque host.
3. Temporary Chromium is used only for official QR login, runs with its system sandbox inside the constrained container, then closes.
4. SQLite and encrypted files live in the instance data directory.
5. A reverse proxy terminates HTTPS for remote clients.

## Primary threats and controls

| Threat | Controls |
| --- | --- |
| Cross-employee session access | One owner per process; independent bearer, key, database, data directory, port, and Compose project |
| Token theft in transit | HTTPS requirement for non-loopback public URLs; explicit insecure override only |
| Host or Origin confusion | Exact Host allowlist, Origin allowlist, fixed Yuque hosts, no arbitrary URL tool |
| Credential leakage | Encrypted session, private file modes, redacted JSON logs, protected metrics, public-content scanner |
| Prompt-induced destructive write | Capability registry, Preview/Confirm, exact digest, deletion flag, exact-path confirmation, configuration switches |
| Concurrent overwrite | Strict mode default; best-effort local serialization, remote lock check, second baseline read, snapshot, single write, read-back |
| Ambiguous network result | No blind retry; read-only reconciliation; terminal `unknown` or `partial` state |
| Unverified endpoint drift | Versioned contract, response shape checks, live-write gate, global write kill switch |
| Malicious oversized request | Request body, session, per-session, login, and concurrency limits |
| Compromised proxy or CA configuration | TLS verification cannot be disabled; explicit proxy/CA configuration only |
| Backup misuse | Private directories, SHA-256 manifest, owner binding, offline restore confirmation |
| Browser sandbox escape surface | Non-root container, read-only root, dropped capabilities, no-new-privileges, reviewed default-deny seccomp profile, no Chromium no-sandbox flags, login-only lifetime |

## Residual risk

Yuque web interfaces do not provide a reliable atomic compare-and-swap primitive for every write. `best_effort` reduces but cannot eliminate the final race between the last baseline check and the remote mutation. Operators that cannot accept this risk must keep `strict` mode. A compromised host or process owner can read runtime secrets; use standard host hardening and least privilege.

The derived Chromium seccomp profile deliberately exposes `chroot`, `clone`, `setns`, and `unshare` so Chromium can create its own user-namespace sandbox under `cap_drop=ALL`. This is a larger syscall surface than Docker's default profile, but materially safer than running Chromium with `--no-sandbox`; the browser remains constrained by the other container controls and is not kept for business requests.

Deep editing of unknown Lake blocks, attachments, boards, and advanced Sheet features remains disabled rather than serialized approximately.
