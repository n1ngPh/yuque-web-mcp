import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CryptoBox } from "./crypto.js";
import type { StoredWebSession } from "./types.js";

export class SessionStore {
  private readonly sessionsDir: string;
  // 旧单文件 session.enc 一旦确认不存在，后续 load 不再重复尝试读取。
  private legacySingleFileAbsent = false;

  constructor(
    private readonly dataDir: string,
    private readonly crypto: CryptoBox,
    // 保留第 3 个参数以兼容旧单租户调用方；多租户下会话按 employeeId 分文件，不再使用它。
    _legacyOwnerId?: string,
  ) {
    this.sessionsDir = join(dataDir, "sessions");
  }

  async save(employeeId: string, session: StoredWebSession): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    await chmod(this.sessionsDir, 0o700);
    const target = this.sessionPath(employeeId);
    const temporary = `${target}.tmp`;
    await writeFile(
      temporary,
      this.crypto.encrypt(session, sessionContext(employeeId)),
      { mode: 0o600 },
    );
    await rename(temporary, target);
    await chmod(target, 0o600);
  }

  async load(employeeId: string): Promise<StoredWebSession | undefined> {
    const target = this.sessionPath(employeeId);
    try {
      const serialized = await readFile(target, "utf8");
      return this.crypto.decrypt<StoredWebSession>(
        serialized,
        sessionContext(employeeId),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.migrateLegacySingleFile(employeeId);
      }
      throw error;
    }
  }

  async remove(employeeId: string): Promise<void> {
    await rm(this.sessionPath(employeeId), { force: true });
  }

  private sessionPath(employeeId: string): string {
    const digest = createHash("sha256").update(employeeId).digest("hex");
    return join(this.sessionsDir, `${digest}.enc`);
  }

  private async migrateLegacySingleFile(
    employeeId: string,
  ): Promise<StoredWebSession | undefined> {
    if (this.legacySingleFileAbsent) return undefined;
    const legacyPath = join(this.dataDir, "session.enc");
    let serialized: string;
    try {
      serialized = await readFile(legacyPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.legacySingleFileAbsent = true;
        return undefined;
      }
      throw error;
    }
    try {
      const session = this.crypto.decrypt<StoredWebSession>(
        serialized,
        sessionContext(employeeId),
      );
      await this.save(employeeId, session);
      return session;
    } catch {
      // AAD mismatch: the legacy single-file session belongs to another owner.
      return undefined;
    }
  }
}

function sessionContext(employeeId: string): string {
  return `yuque-web-session:${employeeId}`;
}
