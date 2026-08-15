import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChangeState, PendingChangeKind } from "./types.js";

export interface PendingChangeRow {
  change_id: string;
  kind: PendingChangeKind;
  encrypted_payload: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
  updated_at: string;
  state: ChangeState;
  diff_digest: string;
  has_deletions: number;
  target_hash: string;
  error_code: string | null;
}

export interface SnapshotRow {
  snapshot_id: string;
  target_hash: string;
  resource_type: "doc" | "sheet";
  encrypted_payload: string;
  created_at: string;
  expires_at: string;
}

export interface AuditEventRow {
  event_id: string;
  target_hash: string;
  operation: string;
  state: ChangeState | "snapshot_created" | "snapshot_expired";
  diff_digest: string | null;
  error_code: string | null;
  created_at: string;
}

/**
 * Embedded, single-owner state store. It never contains MCP credentials,
 * Yuque cookies, CSRF values, employee directories, or plaintext audit bodies.
 */
export class AppDatabase {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_changes (
        change_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        state TEXT NOT NULL,
        diff_digest TEXT NOT NULL,
        has_deletions INTEGER NOT NULL CHECK (has_deletions IN (0, 1)),
        target_hash TEXT NOT NULL,
        error_code TEXT
      );

      CREATE INDEX IF NOT EXISTS pending_changes_expires_idx
      ON pending_changes(expires_at);

      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY,
        target_hash TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('doc', 'sheet')),
        encrypted_payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS snapshots_target_idx
      ON snapshots(target_hash, expires_at);

      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        target_hash TEXT NOT NULL,
        operation TEXT NOT NULL,
        state TEXT NOT NULL,
        diff_digest TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_events_created_idx
      ON audit_events(created_at);

      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '3')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);
  }

  close(): void {
    this.db.close();
  }

  insertPendingChange(row: PendingChangeRow): void {
    this.db
      .prepare(
        `INSERT INTO pending_changes
          (change_id, kind, encrypted_payload, expires_at, consumed_at,
           created_at, updated_at, state, diff_digest, has_deletions,
           target_hash, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.change_id,
        row.kind,
        row.encrypted_payload,
        row.expires_at,
        row.consumed_at,
        row.created_at,
        row.updated_at,
        row.state,
        row.diff_digest,
        row.has_deletions,
        row.target_hash,
        row.error_code,
      );
  }

  getPendingChange(changeId: string): PendingChangeRow | undefined {
    return this.db
      .prepare("SELECT * FROM pending_changes WHERE change_id = ?")
      .get(changeId) as PendingChangeRow | undefined;
  }

  transitionPendingChange(
    changeId: string,
    from: ChangeState[],
    to: ChangeState,
    errorCode?: string,
  ): boolean {
    if (from.length === 0) return false;
    const placeholders = from.map(() => "?").join(", ");
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE pending_changes
         SET state = ?, updated_at = ?, error_code = ?,
             consumed_at = CASE WHEN ? = 'executing' THEN ? ELSE consumed_at END
         WHERE change_id = ? AND state IN (${placeholders})`,
      )
      .run(to, now, errorCode ?? null, to, now, changeId, ...from);
    return result.changes === 1;
  }

  cancelPendingChange(changeId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pending_changes SET state = 'cancelled', updated_at = ?
           WHERE change_id = ? AND state = 'previewed'`,
        )
        .run(new Date().toISOString(), changeId).changes === 1
    );
  }

  insertSnapshot(row: SnapshotRow): void {
    this.db
      .prepare(
        `INSERT INTO snapshots
          (snapshot_id, target_hash, resource_type, encrypted_payload,
           created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.snapshot_id,
        row.target_hash,
        row.resource_type,
        row.encrypted_payload,
        row.created_at,
        row.expires_at,
      );
  }

  listSnapshots(targetHash?: string): SnapshotRow[] {
    return (
      targetHash
        ? this.db
            .prepare(
              `SELECT * FROM snapshots
               WHERE target_hash = ? AND expires_at > ?
               ORDER BY created_at DESC`,
            )
            .all(targetHash, new Date().toISOString())
        : this.db
            .prepare(
              `SELECT * FROM snapshots
               WHERE expires_at > ? ORDER BY created_at DESC`,
            )
            .all(new Date().toISOString())
    ) as SnapshotRow[];
  }

  getSnapshot(snapshotId: string): SnapshotRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM snapshots
         WHERE snapshot_id = ? AND expires_at > ?`,
      )
      .get(snapshotId, new Date().toISOString()) as SnapshotRow | undefined;
  }

  purgeExpiredSnapshots(now = new Date().toISOString()): number {
    return this.db
      .prepare("DELETE FROM snapshots WHERE expires_at <= ?")
      .run(now).changes;
  }

  insertAuditEvent(row: AuditEventRow): void {
    this.db
      .prepare(
        `INSERT INTO audit_events
          (event_id, target_hash, operation, state, diff_digest,
           error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.event_id,
        row.target_hash,
        row.operation,
        row.state,
        row.diff_digest,
        row.error_code,
        row.created_at,
      );
  }
}
