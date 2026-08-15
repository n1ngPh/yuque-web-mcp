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
  private readonly sessionPath: string;
  private readonly legacySessionsDir: string;

  constructor(
    private readonly dataDir: string,
    private readonly crypto: CryptoBox,
    private readonly ownerId: string,
  ) {
    this.sessionPath = join(dataDir, "session.enc");
    this.legacySessionsDir = join(dataDir, "sessions");
  }

  async save(employeeId: string, session: StoredWebSession): Promise<void> {
    this.assertOwner(employeeId);
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    const temporary = `${this.sessionPath}.tmp`;
    await writeFile(
      temporary,
      this.crypto.encrypt(session, sessionContext(employeeId)),
      { mode: 0o600 },
    );
    await rename(temporary, this.sessionPath);
    await chmod(this.sessionPath, 0o600);
  }

  async load(employeeId: string): Promise<StoredWebSession | undefined> {
    this.assertOwner(employeeId);
    try {
      const serialized = await readFile(this.sessionPath, "utf8");
      return this.crypto.decrypt<StoredWebSession>(
        serialized,
        sessionContext(employeeId),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.migrateLegacySession(employeeId);
      }
      throw error;
    }
  }

  async remove(employeeId: string): Promise<void> {
    this.assertOwner(employeeId);
    await rm(this.sessionPath, { force: true });
  }

  private assertOwner(employeeId: string): void {
    if (employeeId !== this.ownerId) {
      throw new Error("Session owner mismatch");
    }
  }

  private async migrateLegacySession(
    employeeId: string,
  ): Promise<StoredWebSession | undefined> {
    const legacyId = createHash("sha256").update(employeeId).digest("hex");
    const legacyPath = join(this.legacySessionsDir, `${legacyId}.enc`);
    try {
      const serialized = await readFile(legacyPath, "utf8");
      const session = this.crypto.decrypt<StoredWebSession>(
        serialized,
        sessionContext(employeeId),
      );
      await this.save(employeeId, session);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

function sessionContext(employeeId: string): string {
  return `yuque-web-session:${employeeId}`;
}
