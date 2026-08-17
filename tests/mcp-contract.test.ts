import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MCP_INSTRUCTIONS,
  createMcpServer,
  toolDefinitions,
} from "../src/mcp.js";

describe("MCP public surface", () => {
  it("exposes exactly the 38 v1.2 tools with capability discovery", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer("employee.a", {} as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.listTools();

    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
    expect(client.getInstructions()).toContain("不要试图一次读取所有文档正文");
    expect(client.getInstructions()).toContain("yuque_list_all_docs");
    expect(client.getInstructions()).toContain("强制路径提示规则");
    expect(client.getInstructions()).toContain(
      "必须先输出“完整路径：<个人：姓名或空间：组织 / 知识库名 / 目录层级 / 文档名>”",
    );
    expect(result.tools.map((tool) => tool.name)).toEqual(
      toolDefinitions.map((tool) => tool.name),
    );
    expect(result.tools).toHaveLength(38);
    expect(result.tools.some((tool) => tool.name === "yuque_list_scopes")).toBe(
      true,
    );
    expect(result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "yuque_get_capabilities",
        "yuque_get_book",
        "yuque_list_book_collaborators",
        "yuque_preview_create_book",
        "yuque_preview_update_book",
        "yuque_preview_change_book_collaborator",
        "yuque_preview_change_catalog",
        "yuque_list_comments",
        "yuque_preview_change_comment",
        "yuque_list_doc_versions",
        "yuque_get_doc_version",
        "yuque_preview_restore_doc_version",
        "yuque_get_export_options",
        "yuque_create_export_link",
        "yuque_preview_delete_doc",
        "yuque_preview_delete_sheet",
        "yuque_preview_delete_book",
      ]),
    );
    expect(client.getInstructions()).toContain(
      "Doc、Sheet和个人知识库整对象删除工具存在，但默认关闭",
    );
    expect(client.getInstructions()).toContain("confirmation_text");
    expect(
      result.tools.find((tool) => tool.name === "yuque_list_all_docs")
        ?.description,
    ).toContain("offset+limit");
    expect(
      result.tools.find((tool) => tool.name === "yuque_get_doc")?.description,
    ).toContain("第一项必须先写完整路径和URL");
    expect(
      result.tools.find((tool) => tool.name === "yuque_create_export_link")
        ?.description,
    ).toContain("不下载或缓存文件");
    expect(
      result.tools.find((tool) => tool.name === "yuque_search")?.description,
    ).toContain("已验证");
    const loginBegin = result.tools.find(
      (tool) => tool.name === "yuque_login_begin",
    );
    expect(JSON.stringify(loginBegin?.inputSchema)).toContain("dingtalk");
    expect(JSON.stringify(loginBegin?.inputSchema)).toContain("wechat");
    expect(JSON.stringify(loginBegin?.inputSchema)).toContain("alipay");
    expect(JSON.stringify(loginBegin?.inputSchema)).not.toContain("password");
    expect(
      result.tools.find((tool) => tool.name === "yuque_get_sheet")?.description,
    ).toContain("已验证基础格式");
    const updateDoc = result.tools.find(
      (tool) => tool.name === "yuque_preview_update_doc",
    );
    expect(JSON.stringify(updateDoc?.inputSchema)).not.toContain(
      "replace_full",
    );
    expect(JSON.stringify(updateDoc?.inputSchema)).toContain("replace_section");
    expect(JSON.stringify(updateDoc?.inputSchema)).toContain("delete_section");
    expect(
      result.tools.find((tool) => tool.name === "yuque_preview_update_sheet")
        ?.description,
    ).toContain("rename_worksheet");
    expect(
      result.tools.find((tool) => tool.name === "yuque_preview_change_catalog")
        ?.description,
    ).toContain("删除仅允许空分组");
    expect(
      result.tools.find((tool) => tool.name === "yuque_preview_change_comment")
        ?.description,
    ).toContain("当前员工自己的评论");
    await client.close();
    await server.close();
  });

  it("returns the verified full path before document body", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer("employee.a", {
      client: {
        getDoc: async () => ({
          id: "10",
          slug: "same-name",
          title: "同名文档",
          markdown: "正文",
          lakeContent:
            '<p data-lake-id="fixture">正文</p><card name="board" value="redacted-board-payload"></card>',
          bookId: 1,
          bookUrl: "https://example-team.yuque.com/team/book",
          format: "lake",
          version: 3,
          url: "https://example-team.yuque.com/team/book/same-name",
          location: {
            path: ["一级目录", "同名文档"],
            fullPath: ["知识库", "一级目录", "同名文档"],
            displayPath: "知识库 / 一级目录 / 同名文档",
            level: 1,
            order: 2,
          },
          raw: {},
          fingerprint: "fingerprint",
        }),
      },
    } as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "yuque_get_doc",
      arguments: {
        doc_url: "https://example-team.yuque.com/team/book/same-name",
      },
    });
    const first = (
      result as { content: Array<{ type: string; text?: string }> }
    ).content[0];
    expect(first?.type).toBe("text");
    if (!first || first.type !== "text" || first.text === undefined)
      throw new Error("Expected text tool result");
    const payload = JSON.parse(first.text) as Record<string, unknown>;
    expect(payload.display_path).toBe("知识库 / 一级目录 / 同名文档");
    expect(payload.full_path).toEqual(["知识库", "一级目录", "同名文档"]);
    expect(payload.proprietary_blocks).toEqual(["board"]);
    expect(first.text.indexOf('"display_path"')).toBeLessThan(
      first.text.indexOf('"body"'),
    );

    await client.close();
    await server.close();
  });

  it("lists type-specific formats before returning a native export URL", async () => {
    const calls: unknown[] = [];
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer("employee.a", {
      client: {
        getExportOptions: async (...args: unknown[]) => {
          calls.push(args);
          return {
            targetType: "Doc",
            sourceFormat: "lake",
            availableFormats: [
              {
                format: "word",
                label: "Word",
                extension: "docx",
                browserLoginExpected: false,
              },
              {
                format: "pdf",
                label: "PDF",
                extension: "pdf",
                browserLoginExpected: true,
              },
            ],
            document: {
              id: "12",
              title: "Export Doc",
              url: "https://www.yuque.com/u1/book/doc",
              bookUrl: "https://www.yuque.com/u1/book",
              displayPath: "个人：Alice / Export Book / Export Doc",
              fullPath: ["个人：Alice", "Export Book", "Export Doc"],
            },
          };
        },
        createExportLink: async (...args: unknown[]) => {
          calls.push(args);
          return {
            targetType: "Doc",
            format: "pdf",
            filename: "Export Doc.pdf",
            downloadUrl:
              "https://www.yuque.com/attachments/__temp/account/date/object?attachable_id=1&attachable_type=Doc&filename=Export%20Doc.pdf",
            browserLoginRequired: true,
            deliveryHost: "www.yuque.com",
            pollRequests: 3,
            document: {
              id: "12",
              title: "Export Doc",
              url: "https://www.yuque.com/u1/book/doc",
              bookUrl: "https://www.yuque.com/u1/book",
              displayPath: "个人：Alice / Export Book / Export Doc",
              fullPath: ["个人：Alice", "Export Book", "Export Doc"],
            },
          };
        },
      },
    } as never);
    const client = new Client({ name: "test-client", version: "1.2.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const optionsResult = await client.callTool({
      name: "yuque_get_export_options",
      arguments: { doc_url: "https://www.yuque.com/u1/book/doc" },
    });
    expect(optionsResult.isError).not.toBe(true);
    const optionsContent = (
      optionsResult as { content: Array<{ type: string; text?: string }> }
    ).content[0];
    expect(JSON.parse(optionsContent?.text ?? "{}")).toMatchObject({
      target_type: "Doc",
      export_started: false,
      available_formats: [{ format: "word" }, { format: "pdf" }],
      document: {
        display_path: "个人：Alice / Export Book / Export Doc",
      },
    });

    const result = await client.callTool({
      name: "yuque_create_export_link",
      arguments: {
        doc_url: "https://www.yuque.com/u1/book/doc",
        format: "pdf",
      },
    });
    expect(result.isError).not.toBe(true);
    const content = (
      result as { content: Array<{ type: string; text?: string }> }
    ).content[0];
    const payload = JSON.parse(content?.text ?? "{}") as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      format: "pdf",
      target_type: "Doc",
      filename: "Export Doc.pdf",
      browser_login_required: true,
      poll_requests: 3,
      file_downloaded_by_mcp: false,
      document: {
        display_path: "个人：Alice / Export Book / Export Doc",
      },
    });
    expect(calls).toEqual([
      ["employee.a", "https://www.yuque.com/u1/book/doc"],
      ["employee.a", "https://www.yuque.com/u1/book/doc", "pdf"],
    ]);
    await client.close();
    await server.close();
  });

  it("routes private personal knowledge-base creation through Preview", async () => {
    const calls: unknown[] = [];
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer("employee.a", {
      changes: {
        previewCreateBook: async (...args: unknown[]) => {
          calls.push(args);
          return {
            display_path: "个人：Alice / yuque-web-mcp-e2e",
            target_url: "https://www.yuque.com/dashboard",
          };
        },
      },
    } as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "yuque_preview_create_book",
      arguments: { name: "yuque-web-mcp-e2e", description: "sandbox" },
    });
    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([
      ["employee.a", { name: "yuque-web-mcp-e2e", description: "sandbox" }],
    ]);
    await client.close();
    await server.close();
  });

  it("routes explicit personal scope without mutating global Yuque context", async () => {
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer("employee.a", {
      client: {
        listScopes: async (...args: unknown[]) => {
          calls.push({ name: "listScopes", args });
          return { defaultScopeId: "organization", scopes: [] };
        },
        listBooks: async (...args: unknown[]) => {
          calls.push({ name: "listBooks", args });
          return [];
        },
        listAllDocs: async (...args: unknown[]) => {
          calls.push({ name: "listAllDocs", args });
          return [];
        },
        search: async (...args: unknown[]) => {
          calls.push({ name: "search", args });
          return { hits: [] };
        },
      },
    } as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await client.callTool({ name: "yuque_list_scopes", arguments: {} });
    await client.callTool({
      name: "yuque_list_books",
      arguments: { scope_id: "personal", limit: 10 },
    });
    await client.callTool({
      name: "yuque_list_all_docs",
      arguments: { scope_id: "personal" },
    });
    await client.callTool({
      name: "yuque_search",
      arguments: {
        scope_id: "personal",
        query: "test01",
        book_url: "https://www.yuque.com/u1/book",
      },
    });
    const invalidScope = await client.callTool({
      name: "yuque_list_books",
      arguments: { scope_id: "shared-global" },
    });

    expect(calls).toEqual([
      { name: "listScopes", args: ["employee.a"] },
      {
        name: "listBooks",
        args: ["employee.a", undefined, 10, "personal"],
      },
      {
        name: "listAllDocs",
        args: ["employee.a", false, "personal"],
      },
      {
        name: "search",
        args: [
          "employee.a",
          "test01",
          "https://www.yuque.com/u1/book",
          20,
          "personal",
        ],
      },
    ]);
    expect(
      toolDefinitions.some((tool) => tool.name === "set_active_scope"),
    ).toBe(false);
    expect(invalidScope.isError).toBe(true);
    const invalidText = (
      invalidScope as { content: Array<{ type: string; text?: string }> }
    ).content[0]?.text;
    expect(JSON.parse(invalidText ?? "{}")).toMatchObject({
      ok: false,
      error: {
        code: "invalid_argument",
        retriable: false,
        relogin_required: false,
      },
    });

    await client.close();
    await server.close();
  });

  it("returns the Sheet full path before bounded typed cells", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer("employee.a", {
      client: {
        getSheet: async () => ({
          id: "20",
          slug: "sheet",
          title: "test_表格",
          format: "lakesheet",
          bookId: 1,
          bookUrl: "https://example-team.yuque.com/team/book",
          version: 2,
          url: "https://example-team.yuque.com/team/book/sheet",
          location: {
            path: ["yuque-web-mcp", "test_表格"],
            fullPath: ["Example Project", "yuque-web-mcp", "test_表格"],
            displayPath: "Example Project / yuque-web-mcp / test_表格",
            level: 1,
            order: 2,
          },
          workbook: {
            id: "20",
            title: "test_表格",
            revision: "2",
            fingerprint: "sheet-fingerprint",
            worksheets: [
              {
                id: "sheet-1",
                name: "Sheet1",
                cells: {
                  A1: { value: "field" },
                  B2: { value: 4, formula: "=B2*2", kind: "formula" },
                },
              },
            ],
          },
          bodyDraft: "fixture-body-draft",
          unsupportedFeatures: [],
          chartSummaries: [
            {
              chartType: "column",
              chartTypeVerifiedOnPersonalHost: true,
              displayConfigProjectionVerifiedOnPersonalHost: true,
              displayConfig: {
                themeIndex: null,
                layoutIndex: null,
                border: null,
                showHiddenData: null,
                showEmptyData: null,
                gridlinesVisible: null,
                yAxisFormatter: null,
                yAxisPrefix: null,
                yAxisSuffix: null,
                titleVisible: null,
                titleText: null,
                xAxisTitleText: null,
                yAxisTitleText: null,
                legendPosition: null,
                dataLabelsVisible: null,
                xAxisTitleVisible: null,
                xAxisLabelVisible: null,
                xAxisLabelRotation: null,
                yAxisTitleVisible: null,
                yAxisMinLimit: null,
                yAxisMaxLimit: null,
              },
              sourceRange: {
                startRow: 0,
                startColumn: 0,
                rowCount: 3,
                columnCount: 2,
              },
              worksheetId: "sheet-1",
              dataWorksheetId: "sheet-1",
            },
          ],
        }),
      },
    } as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "yuque_get_sheet",
      arguments: {
        doc_url: "https://example-team.yuque.com/team/book/sheet",
        range: "A1:B2",
      },
    });
    const first = (
      result as { content: Array<{ type: string; text?: string }> }
    ).content[0];
    if (!first || first.type !== "text" || first.text === undefined)
      throw new Error("Expected text tool result");
    const payload = JSON.parse(first.text) as Record<string, unknown>;
    expect(payload.display_path).toBe(
      "Example Project / yuque-web-mcp / test_表格",
    );
    expect(payload.range).toBe("A1:B2");
    expect(payload.styles_verified).toBe(true);
    expect(payload.verified_formula_functions).toEqual([
      "SUM",
      "AVERAGE",
      "MIN",
      "MAX",
      "COUNT",
      "COUNTA",
      "IF",
      "AND",
      "OR",
      "NOT",
      "IFS",
      "SWITCH",
      "XOR",
      "COUNTIF",
      "SUMIF",
      "COUNTIFS",
      "SUMIFS",
      "AVERAGEIF",
      "AVERAGEIFS",
      "COUNTBLANK",
      "LARGE",
      "SMALL",
      "STDEVP",
      "VARP",
      "STDEVS",
      "VARS",
      "ISBLANK",
      "ISNUMBER",
      "ISTEXT",
      "ISLOGICAL",
      "ISEVEN",
      "ISODD",
      "ABS",
      "ROUND",
      "CEILING",
      "FLOOR",
      "SUMPRODUCT",
      "CHOOSE",
      "RANK",
      "SIGN",
      "PI",
      "EXP",
      "LN",
      "LOG",
      "LOG10",
      "TRUNC",
      "MROUND",
      "QUOTIENT",
      "SIN",
      "COS",
      "TAN",
      "DEGREES",
      "RADIANS",
      "FACT",
      "GCD",
      "LCM",
      "COMBIN",
      "SUMSQ",
      "CONCAT",
      "CONCATENATE",
      "LEFT",
      "RIGHT",
      "MID",
      "LEN",
      "LOWER",
      "UPPER",
      "TRIM",
      "FIND",
      "SEARCH",
      "SUBSTITUTE",
      "REPLACE",
      "REPT",
      "EXACT",
      "PROPER",
      "CHAR",
      "CODE",
      "VALUE",
      "TEXT",
      "ROUNDUP",
      "ROUNDDOWN",
      "INT",
      "MOD",
      "SQRT",
      "POWER",
      "PRODUCT",
      "MEDIAN",
      "VLOOKUP",
      "HLOOKUP",
      "MATCH",
      "INDEX",
      "ROWS",
      "COLUMNS",
    ]);
    expect(payload.verified_formula_functions_host_scope).toBe("personal");
    expect(payload.chart_summaries).toEqual([
      {
        chartType: "column",
        chartTypeVerifiedOnPersonalHost: true,
        displayConfigProjectionVerifiedOnPersonalHost: true,
        displayConfig: {
          themeIndex: null,
          layoutIndex: null,
          border: null,
          showHiddenData: null,
          showEmptyData: null,
          gridlinesVisible: null,
          yAxisFormatter: null,
          yAxisPrefix: null,
          yAxisSuffix: null,
          titleVisible: null,
          titleText: null,
          xAxisTitleText: null,
          yAxisTitleText: null,
          legendPosition: null,
          dataLabelsVisible: null,
          xAxisTitleVisible: null,
          xAxisLabelVisible: null,
          xAxisLabelRotation: null,
          yAxisTitleVisible: null,
          yAxisMinLimit: null,
          yAxisMaxLimit: null,
        },
        sourceRange: {
          startRow: 0,
          startColumn: 0,
          rowCount: 3,
          columnCount: 2,
        },
        worksheetId: "sheet-1",
        dataWorksheetId: "sheet-1",
      },
    ]);
    expect(payload.verified_chart_types).toEqual([
      "column",
      "stackColumn",
      "bar",
      "stackBar",
      "line",
      "smoothLine",
      "pie",
      "ring",
    ]);
    expect(payload.verified_chart_types_host_scope).toBe("personal");
    expect(payload.verified_chart_display_config_paths).toEqual([
      "theme",
      "layout",
      "border",
      "hiddenData",
      "showEmptyData",
      "grid",
      "formatter",
      "prefix",
      "suffix",
      "title.visible",
      "titles.title",
      "titles.xAxis",
      "titles.yAxis",
      "legend.position",
      "label.visible",
      "xAxis.title.visible",
      "xAxis.label.visible",
      "xAxis.label.rotate",
      "yAxis.title.visible",
      "yAxis.minLimit",
      "yAxis.maxLimit",
    ]);
    expect(payload.verified_chart_display_config_chart_types).toEqual([
      "column",
    ]);
    expect(payload.verified_chart_theme_indexes).toEqual([0, 1, 2, 3, 4, 5]);
    expect(payload.verified_chart_layout_indexes).toEqual([0, 1, 2, 3, 4, 5]);
    expect(payload.verified_chart_display_config_host_scope).toBe("personal");
    expect(payload.verified_chart_preview_operations).toEqual([
      "create_column_chart",
      "set_chart_type",
      "update_column_chart_display",
      "delete_chart",
    ]);
    expect(payload.verified_chart_preview_host_scope).toBe("personal");
    expect(payload.chart_preview_supported).toBe(false);
    expect(payload.chart_confirm_supported).toBe(false);
    expect(payload.chart_editing_supported).toBe(false);
    expect(first.text.indexOf('"display_path"')).toBeLessThan(
      first.text.indexOf('"cells"'),
    );

    await client.close();
    await server.close();
  });

  it("returns verified Doc versions and routes restore through the guarded write path", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const document = {
      id: "77",
      title: "version doc",
      url: "https://www.yuque.com/alice/book/version-doc",
      bookUrl: "https://www.yuque.com/alice/book",
      location: {
        path: ["version doc"],
        fullPath: ["个人：Alice", "Book", "version doc"],
        displayPath: "个人：Alice / Book / version doc",
        level: 0,
        order: 0,
      },
    };
    const version = {
      id: "901",
      docId: "77",
      title: "version doc",
      createdAt: "2026-08-16T00:00:00.000Z",
      draft: false,
      released: true,
      publicationStatus: 1,
      authorLogin: "alice",
      versionUrl: undefined,
    };
    const server = createMcpServer("employee.a", {
      client: {
        listDocVersions: async () => ({
          doc: document,
          versions: [version],
          offset: 0,
          limit: 200,
          hasMore: false,
        }),
        getDocVersion: async () => ({
          doc: document,
          version: {
            ...version,
            docType: "Doc",
            format: "lake",
            slug: "version-doc",
            content: "<p>historical body</p>",
            contentHtml: "<p>historical body</p>",
            plainText: "historical body",
            fingerprint: "version-fingerprint",
          },
        }),
      },
      changes: {
        previewRestoreDocVersion: async (
          _ownerId: string,
          input: { docUrl: string; versionId: string },
        ) => ({
          change_token: "version-restore-token",
          diff_digest: "version-restore-digest",
          target_url: input.docUrl,
          display_path: document.location.displayPath,
          source_version_id: input.versionId,
        }),
      },
    } as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.callTool({
      name: "yuque_list_doc_versions",
      arguments: { doc_url: document.url },
    });
    const listedText = (
      listed as { content: Array<{ type: string; text?: string }> }
    ).content[0]?.text;
    expect(listedText).toContain('"display_path"');
    expect(listedText).toContain('"version_id": "901"');
    expect(listedText).toContain('"version_url": null');

    const detail = await client.callTool({
      name: "yuque_get_doc_version",
      arguments: { doc_url: document.url, version_id: "901" },
    });
    const detailText = (
      detail as { content: Array<{ type: string; text?: string }> }
    ).content[0]?.text;
    expect(detailText).toBeTruthy();
    expect(detailText!.indexOf('"display_path"')).toBeLessThan(
      detailText!.indexOf('"body"'),
    );
    expect(detailText).toContain("historical body");

    const restore = await client.callTool({
      name: "yuque_preview_restore_doc_version",
      arguments: { doc_url: document.url, version_id: "901" },
    });
    expect(restore.isError).not.toBe(true);
    const restoreText = (
      restore as { content: Array<{ type: string; text?: string }> }
    ).content[0]?.text;
    expect(restoreText).toContain("version-restore-token");
    expect(restoreText).toContain('"source_version_id": "901"');

    await client.close();
    await server.close();
  });

  it("routes typed Doc and Sheet deletion previews through the shared safe state machine", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const calls: Array<{
      resourceType: "Doc" | "Sheet" | "KnowledgeBase";
      targetUrl: string;
      allowNonempty?: boolean;
    }> = [];
    const preview = (resourceType: "Doc" | "Sheet", docUrl: string) => ({
      change_token: `${resourceType.toLowerCase()}-token`,
      expires_at: "2026-08-16T00:10:00.000Z",
      target_url: docUrl,
      display_path: `个人：Alice / Book / ${resourceType}`,
      diff: `-${resourceType}`,
      diff_digest: `${resourceType.toLowerCase()}-digest`,
      stats: {
        added_lines: 0,
        removed_lines: 1,
        has_deletions: true,
      },
      requires_deletion_confirmation: true,
      warnings: ["trashed"],
    });
    const server = createMcpServer("employee.a", {
      changes: {
        previewDeleteDoc: async (
          _ownerId: string,
          input: { docUrl: string },
        ) => {
          calls.push({ resourceType: "Doc", targetUrl: input.docUrl });
          return preview("Doc", input.docUrl);
        },
        previewDeleteSheet: async (
          _ownerId: string,
          input: { docUrl: string },
        ) => {
          calls.push({ resourceType: "Sheet", targetUrl: input.docUrl });
          return preview("Sheet", input.docUrl);
        },
        previewDeleteBook: async (
          _ownerId: string,
          input: { bookUrl: string; allowNonempty: boolean },
        ) => {
          calls.push({
            resourceType: "KnowledgeBase",
            targetUrl: input.bookUrl,
            allowNonempty: input.allowNonempty,
          });
          return preview("Doc", input.bookUrl);
        },
      },
    } as never);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const docUrl = "https://www.yuque.com/alice/book/doc";
    const sheetUrl = "https://www.yuque.com/alice/book/sheet";
    const doc = await client.callTool({
      name: "yuque_preview_delete_doc",
      arguments: { doc_url: docUrl },
    });
    const sheet = await client.callTool({
      name: "yuque_preview_delete_sheet",
      arguments: { doc_url: sheetUrl },
    });
    const bookUrl = "https://www.yuque.com/alice/book";
    const book = await client.callTool({
      name: "yuque_preview_delete_book",
      arguments: { book_url: bookUrl, allow_nonempty: true },
    });
    expect(doc.isError).not.toBe(true);
    expect(sheet.isError).not.toBe(true);
    expect(book.isError).not.toBe(true);
    expect(JSON.stringify(doc)).toContain("doc-token");
    expect(JSON.stringify(sheet)).toContain("sheet-token");
    expect(calls).toEqual([
      { resourceType: "Doc", targetUrl: docUrl },
      { resourceType: "Sheet", targetUrl: sheetUrl },
      {
        resourceType: "KnowledgeBase",
        targetUrl: bookUrl,
        allowNonempty: true,
      },
    ]);

    await client.close();
    await server.close();
  });
});
