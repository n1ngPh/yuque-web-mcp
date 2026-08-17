import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CookieJar } from "tough-cookie";
import type { AppConfig } from "../src/config.js";
import { ContractRegistry } from "../src/contracts.js";
import { CryptoBox } from "../src/crypto.js";
import { SessionStore } from "../src/session-store.js";
import { validateExportUrl, YuqueWebClient } from "../src/yuque-client.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("native document export links", () => {
  it("accepts only the captured Doc and Sheet delivery URL contracts", () => {
    const origin = "https://www.yuque.com";
    const common = {
      targetType: "Doc" as const,
      documentOrigin: origin,
      ownerSlug: "u10001",
      bookSlug: "book",
      docSlug: "doc",
    } as const;
    const expires = Math.floor(Date.now() / 1_000) + 3_600;
    expect(
      validateExportUrl({
        ...common,
        format: "word",
        rawUrl: `https://lark-temp.oss-cn-hangzhou.aliyuncs.com/__temp/0/docx/file.docx?OSSAccessKeyId=key&Expires=${String(expires)}&Signature=sig`,
      }),
    ).toMatchObject({
      browserLoginRequired: false,
      host: "lark-temp.oss-cn-hangzhou.aliyuncs.com",
    });
    expect(
      validateExportUrl({
        ...common,
        format: "markdown",
        rawUrl:
          "https://www.yuque.com/u10001/book/doc/markdown?attachment=1&latexcode=1&anchor=0&linebreak=0&useMdai=1",
      }),
    ).toMatchObject({ browserLoginRequired: true, host: "www.yuque.com" });
    expect(
      validateExportUrl({
        ...common,
        format: "lake",
        rawUrl: "https://www.yuque.com/u10001/book/doc/lake?attachment=1",
      }),
    ).toMatchObject({ browserLoginRequired: true });
    for (const format of ["pdf", "jpg"] as const) {
      expect(
        validateExportUrl({
          ...common,
          format,
          rawUrl:
            "/attachments/__temp/1/20260817/file?attachable_id=1&attachable_type=Doc&filename=file",
        }),
      ).toMatchObject({ browserLoginRequired: true });
    }
    const sheetCommon = { ...common, targetType: "Sheet" as const };
    expect(
      validateExportUrl({
        ...sheetCommon,
        format: "excel",
        rawUrl:
          "/attachments/__temp/1/xlsx/file.xlsx?attachable_id=1&attachable_type=Sheet&filename=file.xlsx",
      }),
    ).toMatchObject({ browserLoginRequired: true });
    expect(
      validateExportUrl({
        ...sheetCommon,
        format: "lakesheet",
        rawUrl: "https://www.yuque.com/u10001/book/doc/lakesheet?attachment=1",
      }),
    ).toMatchObject({ browserLoginRequired: true });
    expect(() =>
      validateExportUrl({
        ...sheetCommon,
        format: "word",
        rawUrl: `https://lark-temp.oss-cn-hangzhou.aliyuncs.com/__temp/0/docx/file.docx?OSSAccessKeyId=key&Expires=${String(expires)}&Signature=sig`,
      }),
    ).toThrow("not enabled");
  });

  it("fails closed for expired signatures, unknown Hosts and changed routes", () => {
    const common = {
      targetType: "Doc" as const,
      documentOrigin: "https://www.yuque.com",
      ownerSlug: "u10001",
      bookSlug: "book",
      docSlug: "doc",
    } as const;
    expect(() =>
      validateExportUrl({
        ...common,
        format: "word",
        rawUrl:
          "https://lark-temp.oss-cn-hangzhou.aliyuncs.com/__temp/0/docx/file.docx?OSSAccessKeyId=key&Expires=1&Signature=sig",
      }),
    ).toThrow("expired");
    expect(() =>
      validateExportUrl({
        ...common,
        format: "markdown",
        rawUrl:
          "https://untrusted.example/u10001/book/doc/markdown?attachment=1&latexcode=1&anchor=0&linebreak=0&useMdai=1",
      }),
    ).toThrow("unknown delivery Host");
    expect(() =>
      validateExportUrl({
        ...common,
        format: "lake",
        rawUrl: "https://www.yuque.com/u10001/book/other/lake?attachment=1",
      }),
    ).toThrow("route changed");
  });

  it("discovers formats and polls the verified export task without reading the file", async () => {
    let exportRequests = 0;
    const exportBodies: Record<string, unknown>[] = [];
    const expires = Math.floor(Date.now() / 1_000) + 3_600;
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/mine/personal_books") {
        return response.end(
          JSON.stringify({
            data: [
              {
                id: 11,
                slug: "book",
                name: "Export Book",
                items_count: 2,
                public: 0,
                user: { login: "u10001", type: "User" },
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/docs/doc") {
        return response.end(
          JSON.stringify({
            data: {
              id: 12,
              title: "Export Doc",
              slug: "doc",
              book_id: 11,
              content: "<p>not returned by the export tool</p>",
              format: "lake",
              type: "Doc",
              draft_version: 3,
              abilities: { export: true },
            },
          }),
        );
      }
      if (url.pathname === "/api/docs/sheet") {
        return response.end(
          JSON.stringify({
            data: {
              id: 13,
              title: "Export Sheet",
              slug: "sheet",
              book_id: 11,
              content: "opaque-sheet-content",
              format: "lakesheet",
              type: "Sheet",
              draft_version: 4,
              abilities: { export: true },
            },
          }),
        );
      }
      if (url.pathname === "/api/catalog_nodes") {
        return response.end(
          JSON.stringify({
            data: [
              {
                type: "DOC",
                title: "Export Doc",
                uuid: "doc-node",
                parent_uuid: "",
                level: 0,
                visible: 1,
                doc_id: 12,
                url: "doc",
              },
              {
                type: "DOC",
                title: "Export Sheet",
                uuid: "sheet-node",
                parent_uuid: "",
                level: 0,
                visible: 1,
                doc_id: 13,
                url: "sheet",
              },
            ],
          }),
        );
      }
      if (url.pathname === "/api/docs/12/export") {
        exportRequests += 1;
        exportBodies.push(await jsonBody(request));
        return response.end(
          JSON.stringify({
            data:
              exportRequests === 1
                ? { state: "processing" }
                : {
                    state: "success",
                    url: `https://lark-temp.oss-cn-hangzhou.aliyuncs.com/__temp/0/docx/file.docx?OSSAccessKeyId=key&Expires=${String(expires)}&Signature=sig`,
                  },
          }),
        );
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("No test server address");
    }
    const directory = await mkdtemp(join(tmpdir(), "yuque-export-link-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const origin = `http://127.0.0.1:${address.port}`;
    const contractPath = join(directory, "contract.json");
    await writeFile(
      contractPath,
      JSON.stringify({
        version: "export-link-test",
        verifiedAt: new Date().toISOString(),
        sourceBundles: [],
        endpoints: [
          endpoint("list_personal_books", "GET", "/api/mine/personal_books", [
            "data",
          ]),
          endpoint("get_doc", "GET", "/api/docs/{docSlug}", [
            "data.id",
            "data.abilities.export",
          ]),
          endpoint("get_toc", "GET", "/api/catalog_nodes", ["data"]),
          endpoint("create_doc_export", "POST", "/api/docs/{docId}/export", [
            "data.state",
          ]),
        ],
      }),
    );
    const sessions = new SessionStore(
      directory,
      new CryptoBox(randomBytes(32)),
      "employee.a",
    );
    await sessions.save("employee.a", {
      cookies: new CookieJar().serializeSync(),
      csrfToken: "csrf",
      account: { id: "1", login: "u10001", name: "Alice" },
      savedAt: new Date().toISOString(),
    });
    const client = new YuqueWebClient(
      testConfig(directory, contractPath, origin),
      await ContractRegistry.load(contractPath),
      sessions,
      undefined,
      async () => undefined,
    );
    cleanups.push(() => client.close());

    await expect(
      client.getExportOptions("employee.a", `${origin}/u10001/book/doc`),
    ).resolves.toMatchObject({
      targetType: "Doc",
      availableFormats: [
        { format: "word" },
        { format: "markdown" },
        { format: "pdf" },
        { format: "lake" },
        { format: "jpg" },
      ],
      document: {
        displayPath: "个人：Alice / Export Book / Export Doc",
      },
    });
    await expect(
      client.getExportOptions("employee.a", `${origin}/u10001/book/sheet`),
    ).resolves.toMatchObject({
      targetType: "Sheet",
      availableFormats: [{ format: "excel" }, { format: "lakesheet" }],
      document: {
        displayPath: "个人：Alice / Export Book / Export Sheet",
      },
    });
    await expect(
      client.createExportLink(
        "employee.a",
        `${origin}/u10001/book/sheet`,
        "word",
      ),
    ).rejects.toThrow("cannot be exported as word");
    await expect(
      client.createExportLink(
        "employee.a",
        `${origin}/u10001/book/doc`,
        "word",
      ),
    ).resolves.toMatchObject({
      format: "word",
      targetType: "Doc",
      filename: "Export Doc.docx",
      browserLoginRequired: false,
      pollRequests: 2,
      document: {
        displayPath: "个人：Alice / Export Book / Export Doc",
      },
    });
    expect(exportRequests).toBe(2);
    expect(exportBodies).toEqual([
      { type: "word", force: 0 },
      { type: "word", force: 0 },
    ]);
  });
});

async function jsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return JSON.parse(body) as Record<string, unknown>;
}

function endpoint(
  capability: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  requiredResponsePaths: string[],
) {
  return {
    capability,
    verified: true,
    verifiedHostTypes: ["personal"],
    method,
    path,
    idempotent: method === "GET",
    requiredResponsePaths,
  };
}

function testConfig(
  directory: string,
  contractPath: string,
  origin: string,
): AppConfig {
  return {
    ownerId: "employee.a",
    mcpBearerToken: "t".repeat(40),
    host: "127.0.0.1",
    port: 3000,
    publicBaseUrl: "http://127.0.0.1:3000",
    yuqueHost: origin,
    personalYuqueHost: origin,
    organization: "",
    dataDir: directory,
    databasePath: join(directory, "state.db"),
    contractPath,
    allowedHosts: [],
    allowedOrigins: [],
    encryptionKey: randomBytes(32),
    chromiumExecutable: "/unused",
    loginTtlSeconds: 300,
    changeTtlSeconds: 600,
    requestTimeoutMs: 2_000,
    writeConsistencyMode: "strict",
    allowUnverifiedContracts: false,
    allowObjectDeletion: false,
    allowPermissionChanges: false,
  };
}
