import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";

afterEach(() => vi.unstubAllEnvs());

describe("production configuration", () => {
  it("defaults write consistency to strict", () => {
    requiredEnvironment();
    expect(loadConfig().writeConsistencyMode).toBe("strict");
  });

  it("parses the optional SMS captcha sidecar configuration", () => {
    requiredEnvironment();
    const defaults = loadConfig();
    expect(defaults.smsCaptchaEnabled).toBe(false);
    expect(defaults.captchaPythonPath).toBe("python3");
    expect(defaults.captchaSolvePath).toBe(resolve("captcha/solve.py"));
    expect(defaults.captchaBrowserPath).toBe("/usr/bin/chromium");

    vi.stubEnv("SMS_CAPTCHA_ENABLED", "true");
    vi.stubEnv("CAPTCHA_PYTHON_PATH", "/opt/captcha-venv/bin/python");
    vi.stubEnv("CAPTCHA_SOLVE_PATH", "/app/captcha/solve.py");
    vi.stubEnv("CAPTCHA_BROWSER_PATH", "/usr/bin/google-chrome");
    const configured = loadConfig();
    expect(configured.smsCaptchaEnabled).toBe(true);
    expect(configured.captchaPythonPath).toBe("/opt/captcha-venv/bin/python");
    expect(configured.captchaSolvePath).toBe("/app/captcha/solve.py");
    expect(configured.captchaBrowserPath).toBe("/usr/bin/google-chrome");

    vi.stubEnv("SMS_CAPTCHA_ENABLED", "not-a-bool");
    expect(() => loadConfig()).toThrow(
      "SMS_CAPTCHA_ENABLED must be true or false",
    );
  });

  it("accepts only explicit strict or best_effort values", () => {
    requiredEnvironment();
    vi.stubEnv("WRITE_CONSISTENCY_MODE", "best_effort");
    expect(loadConfig().writeConsistencyMode).toBe("best_effort");

    vi.stubEnv("WRITE_CONSISTENCY_MODE", "unsafe");
    expect(() => loadConfig()).toThrow(
      "WRITE_CONSISTENCY_MODE must be strict or best_effort",
    );
  });

  it("loads private secret files and production limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "yuque-config-"));
    try {
      const tokenFile = join(root, "token");
      const keyFile = join(root, "key");
      await writeFile(tokenFile, `${"t".repeat(48)}\n`, { mode: 0o600 });
      await writeFile(keyFile, `${Buffer.alloc(32, 8).toString("base64")}\n`, {
        mode: 0o600,
      });
      requiredEnvironment();
      vi.stubEnv("MCP_BEARER_TOKEN", undefined);
      vi.stubEnv("SESSION_ENCRYPTION_KEY", undefined);
      vi.stubEnv("MCP_BEARER_TOKEN_FILE", tokenFile);
      vi.stubEnv("SESSION_ENCRYPTION_KEY_FILE", keyFile);
      vi.stubEnv("MAX_MCP_SESSIONS", "7");
      vi.stubEnv("WRITE_KILL_SWITCH", "true");
      const config = loadConfig();
      expect(config.mcpBearerToken).toBe("t".repeat(48));
      expect(config.encryptionKey).toEqual(Buffer.alloc(32, 8));
      expect(config.maxMcpSessions).toBe(7);
      expect(config.writeKillSwitch).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit acceptance for non-loopback plain HTTP", () => {
    requiredEnvironment();
    vi.stubEnv("PUBLIC_BASE_URL", "http://192.0.2.10:18080");
    expect(() => loadConfig()).toThrow("must use HTTPS");
    vi.stubEnv("ALLOW_INSECURE_HTTP", "true");
    expect(loadConfig().allowInsecureHttp).toBe(true);
  });

  it("forbids disabling TLS certificate verification", () => {
    requiredEnvironment();
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    expect(() => loadConfig()).toThrow("is forbidden");
  });

  it("rejects malformed identities, secrets, limits, and boolean switches", () => {
    requiredEnvironment();
    vi.stubEnv("MCP_OWNER_ID", "employee with spaces");
    expect(() => loadConfig()).toThrow("MCP_OWNER_ID");

    resetRequiredEnvironment();
    vi.stubEnv("MCP_BEARER_TOKEN", "too-short");
    expect(() => loadConfig()).toThrow("at least 32 bytes");

    resetRequiredEnvironment();
    vi.stubEnv("PORT", "0");
    expect(() => loadConfig()).toThrow("positive integer");

    resetRequiredEnvironment();
    vi.stubEnv("MAX_MCP_SESSIONS", "10001");
    expect(() => loadConfig()).toThrow("must not exceed 10000");

    resetRequiredEnvironment();
    vi.stubEnv("METRICS_ENABLED", "sometimes");
    expect(() => loadConfig()).toThrow("must be true or false");
  });

  it("requires an explicit Host allowlist for non-loopback listeners", () => {
    requiredEnvironment();
    vi.stubEnv("HOST", "0.0.0.0");
    vi.stubEnv("PUBLIC_BASE_URL", "https://mcp.example.test");
    expect(() => loadConfig()).toThrow("MCP_ALLOWED_HOSTS is required");

    vi.stubEnv(
      "MCP_ALLOWED_HOSTS",
      "mcp.example.test, alternate.example.test:18080",
    );
    expect(loadConfig().allowedHosts).toEqual([
      "mcp.example.test",
      "alternate.example.test:18080",
    ]);
  });

  it("validates exact knowledge-base allowlist URLs", () => {
    requiredEnvironment();
    vi.stubEnv("YUQUE_WRITE_BOOK_ALLOWLIST", "not-a-url");
    expect(() => loadConfig()).toThrow("absolute URLs");

    vi.stubEnv("YUQUE_WRITE_BOOK_ALLOWLIST", "file:///owner/book");
    expect(() => loadConfig()).toThrow("configured Yuque Host");

    vi.stubEnv(
      "YUQUE_WRITE_BOOK_ALLOWLIST",
      "https://unrelated.example.test/owner/book",
    );
    expect(() => loadConfig()).toThrow("configured Yuque Host");

    vi.stubEnv(
      "YUQUE_WRITE_BOOK_ALLOWLIST",
      "https://www.yuque.com/owner/book?mode=edit",
    );
    expect(() => loadConfig()).toThrow("query or fragment");

    vi.stubEnv(
      "YUQUE_WRITE_BOOK_ALLOWLIST",
      "https://user:password@www.yuque.com/owner/book",
    );
    expect(() => loadConfig()).toThrow("cannot contain credentials");

    vi.stubEnv(
      "YUQUE_WRITE_BOOK_ALLOWLIST",
      "https://www.yuque.com/owner/book/extra",
    );
    expect(() => loadConfig()).toThrow("one exact knowledge base");

    vi.stubEnv(
      "YUQUE_WRITE_BOOK_ALLOWLIST",
      "https://www.yuque.com/owner/book/, https://www.yuque.com/a%20b/c",
    );
    expect(loadConfig().writeBookAllowlist).toEqual([
      "https://www.yuque.com/owner/book",
      "https://www.yuque.com/a%20b/c",
    ]);
  });

  it("requires safe Yuque origins and scopes writes to those origins", () => {
    requiredEnvironment();
    vi.stubEnv("YUQUE_HOST", "http://team.example.test");
    expect(() => loadConfig()).toThrow("YUQUE_HOST must be an HTTPS origin");

    vi.stubEnv("YUQUE_HOST", "https://team.example.test/path");
    expect(() => loadConfig()).toThrow("without credentials, path");

    vi.stubEnv("YUQUE_HOST", "https://team.example.test");
    vi.stubEnv("YUQUE_PERSONAL_HOST", "https://www.yuque.com");
    vi.stubEnv(
      "YUQUE_WRITE_BOOK_ALLOWLIST",
      "https://team.example.test/owner/team-book,https://www.yuque.com/owner/personal-book",
    );
    expect(loadConfig().writeBookAllowlist).toEqual([
      "https://team.example.test/owner/team-book",
      "https://www.yuque.com/owner/personal-book",
    ]);
  });

  it("rejects unsafe public URLs and invalid proxy URLs", () => {
    requiredEnvironment();
    vi.stubEnv("PUBLIC_BASE_URL", "relative/path");
    expect(() => loadConfig()).toThrow("absolute HTTP(S) URL");

    vi.stubEnv("PUBLIC_BASE_URL", "https://user:pass@example.test/mcp");
    expect(() => loadConfig()).toThrow("without credentials");

    resetRequiredEnvironment();
    vi.stubEnv("YUQUE_HTTPS_PROXY", "not-a-url");
    expect(() => loadConfig()).toThrow("absolute HTTP(S) URL");

    vi.stubEnv("YUQUE_HTTPS_PROXY", "socks5://proxy.example.test:1080");
    expect(() => loadConfig()).toThrow("must use HTTP or HTTPS");

    vi.stubEnv("YUQUE_HTTPS_PROXY", "http://user:pass@proxy.example.test:8080");
    expect(loadConfig().yuqueHttpsProxy).toBe(
      "http://user:pass@proxy.example.test:8080/",
    );
  });

  it("validates environment and secret files before reading them", async () => {
    const root = await mkdtemp(join(tmpdir(), "yuque-config-files-"));
    try {
      const malformed = join(root, "malformed.env");
      await writeFile(malformed, "NOT_AN_ASSIGNMENT\n", { mode: 0o600 });
      requiredEnvironment();
      vi.stubEnv("YUQUE_MCP_ENV_FILE", malformed);
      expect(() => loadConfig()).toThrow("invalid line");

      const invalidKey = join(root, "invalid-key.env");
      await writeFile(invalidKey, "lowercase=value\n", { mode: 0o600 });
      vi.stubEnv("YUQUE_MCP_ENV_FILE", invalidKey);
      expect(() => loadConfig()).toThrow("invalid key");

      resetRequiredEnvironment();
      const tokenFile = join(root, "token");
      await writeFile(tokenFile, "x".repeat(48), { mode: 0o600 });
      vi.stubEnv("MCP_BEARER_TOKEN_FILE", tokenFile);
      expect(() => loadConfig()).toThrow("cannot both be configured");

      resetRequiredEnvironment();
      vi.stubEnv("MCP_BEARER_TOKEN", undefined);
      vi.stubEnv("MCP_BEARER_TOKEN_FILE", "relative-token");
      expect(() => loadConfig()).toThrow("must be an absolute path");

      const linkedToken = join(root, "linked-token");
      await symlink(tokenFile, linkedToken);
      vi.stubEnv("MCP_BEARER_TOKEN_FILE", linkedToken);
      expect(() => loadConfig()).toThrow("cannot be a symlink");

      const writableToken = join(root, "writable-token");
      await writeFile(writableToken, "x".repeat(48), { mode: 0o666 });
      await chmod(writableToken, 0o666);
      vi.stubEnv("MCP_BEARER_TOKEN_FILE", writableToken);
      expect(() => loadConfig()).toThrow("group- or world-writable");

      const directory = join(root, "token-directory");
      await mkdir(directory, { mode: 0o700 });
      vi.stubEnv("MCP_BEARER_TOKEN_FILE", directory);
      expect(() => loadConfig()).toThrow("regular file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function requiredEnvironment(): void {
  vi.stubEnv("MCP_OWNER_ID", "employee.a");
  vi.stubEnv("MCP_BEARER_TOKEN", "t".repeat(40));
  vi.stubEnv("SESSION_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("DATA_DIR", "/tmp/yuque-web-mcp-config-test");
  vi.stubEnv("CONTRACT_PATH", "/tmp/yuque-web-mcp-contract-test.json");
  vi.stubEnv("HOST", "127.0.0.1");
}

function resetRequiredEnvironment(): void {
  vi.unstubAllEnvs();
  requiredEnvironment();
}
