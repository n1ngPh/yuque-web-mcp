# Operations

## Preflight

1. Use a fixed image tag or digest.
2. Keep one data directory and secret set per employee.
3. Bind the container to loopback and terminate HTTPS at a reverse proxy.
4. Run `admin doctor` and check `/readyz` before client registration.
5. Keep `WRITE_KILL_SWITCH=true` during initial login and read-only validation, then explicitly choose the write policy.
6. Keep `deploy/chromium-seccomp.json` attached through `security_opt`, together with non-root execution, `read_only`, `cap_drop=ALL`, and `no-new-privileges`. Never substitute `seccomp=unconfined` or Chromium no-sandbox flags.

Before registering an employee, exercise one QR-login browser launch in the final container and inspect the launch command. It must succeed without `--no-sandbox` or `--disable-setuid-sandbox`. The shipped profile is derived from Playwright `v1.62.1` commit `26a9e470a7b3c7822084b09fb7f13902c5f37b51` and adds unconditional `chroot` for the user-namespace sandbox under `cap_drop=ALL`; its expected SHA-256 is `b3995c4964bc2e3e7e87f38df281e5ad8cd8bfb76c6b31b65dea159d46cf1fdb`.

## Backup and restore

Create an online SQLite-consistent backup:

```bash
npm run build
YUQUE_MCP_ENV_FILE=/absolute/path/service.env \
  npm run admin -- backup --output /absolute/private/backups/backup-001
```

The regular backup does not contain the AES key; retain the matching secret separately. Stop the service before restore:

```bash
YUQUE_MCP_ENV_FILE=/absolute/path/service.env \
  npm run admin -- restore \
  --from /absolute/private/backups/backup-001 \
  --confirmation RESTORE:<owner-id>
```

Restore creates a private pre-restore rollback directory and verifies the backup owner, file allowlist, SHA-256 digests, and SQLite integrity.

## Secret rotation

Stop the instance first. Token rotation prints the new token once so it can be placed in the employee's MCP client:

```bash
YUQUE_MCP_ENV_FILE=/absolute/path/service.env npm run admin -- rotate-token
```

Key rotation re-encrypts the session, pending changes, and snapshots and creates a private recovery bundle containing the old key:

```bash
YUQUE_MCP_ENV_FILE=/absolute/path/service.env npm run admin -- rotate-key
```

Restart, run `admin doctor`, verify login state and read access, then retain or securely remove recovery material according to company policy.

## Upgrade and rollback

1. Back up the instance.
2. Pull a fixed new image.
3. Start it and wait for `/readyz`.
4. Verify the per-instance `chromium-seccomp.json` still matches the reviewed release profile and perform the constrained Chromium launch check.
5. Run read-only contract checks before enabling Confirm.
6. On failure, restore the previous Compose image reference and restart it. If a data migration prevents startup, restore the pre-upgrade backup with the previous key.

Never run an unpinned `latest` image or perform a runtime `git pull` inside a deployed instance.

## Optional read-only soak

Operators may run the read-only soak against an exact deployment for a chosen
diagnostic window. It is not a mandatory v1.0 release gate. The checkpoint
contains counters and timestamps only; keep it outside the source tree.
Optional Doc and Sheet targets require one exact allowed knowledge-base URL and
are never discovered automatically.

```bash
MCP_ENV_FILE=/absolute/private/service.env \
SOAK_STATE_FILE=/absolute/private/soak-state.json \
npm run soak:http
```

Set `SOAK_DURATION_SECONDS` to the intended diagnostic window. An interrupted
or failed run is evidence only for the interval that actually completed. The
default tool requires at least 95% of the expected one-minute cycles and rejects
a cycle gap longer than five minutes, including a host sleep or a suspended
process. `SOAK_MIN_CYCLE_RATIO_PERCENT` and `SOAK_MAX_CYCLE_GAP_SECONDS` exist
for controlled test harnesses and must be reported whenever they are changed.

## Incident response

1. Set `WRITE_KILL_SWITCH=true` and restart.
2. Preserve redacted JSON logs and audit hashes; do not collect document bodies by default.
3. Rotate the MCP token if client access may be compromised.
4. Reset the local Yuque session if cookies may be compromised.
5. Compare the contract version and front-end fingerprint before re-enabling writes.
