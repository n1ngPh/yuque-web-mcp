import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { CryptoBox } from "../src/crypto.js";
import { AppDatabase } from "../src/db.js";
import { AuthService } from "../src/auth.js";
import { SessionStore } from "../src/session-store.js";
import type { StoredWebSession } from "../src/types.js";

const temporaryDirectories: string[] = [];
const OWNER_ID = "employee.a";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("single-owner security boundaries", () => {
  it("accepts only the configured Bearer token without persisting it", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "state.db");
    const token = randomBytes(32).toString("base64url");
    const auth = new AuthService(OWNER_ID, token);
    const db = new AppDatabase(databasePath);

    expect(auth.authenticate(token)).toEqual({ ownerId: OWNER_ID });
    expect(auth.authenticate(`${token}x`)).toBeUndefined();
    expect(auth.authenticate("")).toBeUndefined();

    const reader = new Database(databasePath, { readonly: true });
    const tables = (
      reader
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const columns = tables.flatMap((table) =>
      (
        reader.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((column) => `${table}.${column.name}`),
    );
    expect(tables).not.toContain("employees");
    expect(
      columns.some((name) => /token|cookie|csrf|authorization/i.test(name)),
    ).toBe(false);
    reader.close();

    expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
    db.close();
  });

  it("encrypts the owner's Cookie Jar and account binding in one local file", async () => {
    const directory = await temporaryDirectory();
    const crypto = new CryptoBox(randomBytes(32));
    const store = new SessionStore(directory, crypto, OWNER_ID);
    const session = webSession();

    await store.save(OWNER_ID, session);
    await expect(store.load(OWNER_ID)).resolves.toEqual(session);
    await expect(store.load("employee.b")).rejects.toThrow(
      "Session owner mismatch",
    );
    await expect(store.save("employee.b", session)).rejects.toThrow(
      "Session owner mismatch",
    );

    const serialized = await readFile(join(directory, "session.enc"), "utf8");
    expect(serialized).not.toContain("secret-cookie");
    expect(serialized).not.toContain("sensitive-value");
    expect(serialized).not.toContain("csrf-secret");
    expect(serialized).not.toContain("alice-secret-login");
    expect((await stat(join(directory, "session.enc"))).mode & 0o777).toBe(
      0o600,
    );

    await store.remove(OWNER_ID);
    await expect(store.load(OWNER_ID)).resolves.toBeUndefined();
  });

  it("migrates the previous per-employee encrypted session without deleting it", async () => {
    const directory = await temporaryDirectory();
    const crypto = new CryptoBox(randomBytes(32));
    const legacyDirectory = join(directory, "sessions");
    const legacyName = `${createHash("sha256").update(OWNER_ID).digest("hex")}.enc`;
    const legacyPath = join(legacyDirectory, legacyName);
    const session = webSession();
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(
      legacyPath,
      crypto.encrypt(session, `yuque-web-session:${OWNER_ID}`),
      { mode: 0o600 },
    );

    const store = new SessionStore(directory, crypto, OWNER_ID);
    await expect(store.load(OWNER_ID)).resolves.toEqual(session);
    await expect(
      readFile(join(directory, "session.enc"), "utf8"),
    ).resolves.toBeTruthy();
    await expect(readFile(legacyPath, "utf8")).resolves.toBeTruthy();
  });

  it("rejects a tampered encrypted session", async () => {
    const directory = await temporaryDirectory();
    const crypto = new CryptoBox(randomBytes(32));
    const store = new SessionStore(directory, crypto, OWNER_ID);
    await store.save(OWNER_ID, webSession());
    const path = join(directory, "session.enc");
    const envelope = JSON.parse(await readFile(path, "utf8")) as {
      ciphertext: string;
    };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
    await writeFile(path, JSON.stringify(envelope));

    await expect(store.load(OWNER_ID)).rejects.toThrow();
  });
});

function webSession(): StoredWebSession {
  return {
    cookies: {
      cookies: [{ key: "secret-cookie", value: "sensitive-value" }],
    },
    csrfToken: "csrf-secret",
    account: {
      id: "1",
      login: "alice-secret-login",
      name: "Alice Secret Name",
    },
    savedAt: new Date().toISOString(),
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yuque-web-mcp-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
