import { readFile } from "node:fs/promises";

const fileEnvironment = process.env.MCP_ENV_FILE
  ? parseEnvironment(await readFile(process.env.MCP_ENV_FILE, "utf8"))
  : {};
const packageVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const publicBaseUrl =
  process.env.PUBLIC_BASE_URL || fileEnvironment.PUBLIC_BASE_URL;
const baseUrl =
  process.env.MCP_URL ||
  (publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/mcp` : undefined) ||
  "http://127.0.0.1:18080/mcp";
const token = process.env.MCP_BEARER_TOKEN || fileEnvironment.MCP_BEARER_TOKEN;
if (!token) throw new Error("MCP_BEARER_TOKEN is required");

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/json, text/event-stream",
  "Content-Type": "application/json",
};
const initialize = await fetch(baseUrl, {
  method: "POST",
  headers,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "yuque-web-mcp-smoke", version: packageVersion },
    },
  }),
});
if (!initialize.ok) throw new Error(`initialize failed: ${initialize.status}`);
const sessionId = initialize.headers.get("mcp-session-id");
if (!sessionId) throw new Error("initialize did not return Mcp-Session-Id");
const initializePayload = await mcpPayload(initialize);
const instructions = initializePayload.result?.instructions;
if (
  typeof instructions !== "string" ||
  !instructions.includes("yuque_list_all_docs") ||
  !instructions.includes("不要试图一次读取所有文档正文")
) {
  throw new Error("initialize did not return the approved usage instructions");
}

const list = await fetch(baseUrl, {
  method: "POST",
  headers: { ...headers, "Mcp-Session-Id": sessionId },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }),
});
if (!list.ok) throw new Error(`tools/list failed: ${list.status}`);
const payload = await mcpPayload(list);
const count = payload.result?.tools?.length;
if (count !== 38)
  throw new Error(`expected 38 tools, received ${String(count)}`);
const allDocs = payload.result?.tools?.find(
  (tool) => tool.name === "yuque_list_all_docs",
);
if (!allDocs?.description?.includes("offset+limit")) {
  throw new Error("tools/list is missing the document pagination guidance");
}
const capabilityResponse = await fetch(baseUrl, {
  method: "POST",
  headers: { ...headers, "Mcp-Session-Id": sessionId },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "yuque_get_capabilities", arguments: {} },
  }),
});
if (!capabilityResponse.ok) {
  throw new Error(
    `yuque_get_capabilities failed: ${capabilityResponse.status}`,
  );
}
const capabilityPayload = await mcpPayload(capabilityResponse);
const capabilityText = capabilityPayload.result?.content?.[0]?.text;
const capabilityReport = JSON.parse(capabilityText || "null");
if (
  capabilityReport?.server_version !== packageVersion ||
  !["strict", "best_effort"].includes(capabilityReport?.write_consistency_mode)
) {
  throw new Error("Capability Registry response is missing or incompatible");
}
process.stdout.write(
  `${JSON.stringify({ status: "ok", tool_count: count, instructions: "present", write_consistency_mode: capabilityReport.write_consistency_mode })}\n`,
);

async function mcpPayload(response) {
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice(5)
    .trim();
  return JSON.parse(dataLine || text);
}

function parseEnvironment(serialized) {
  const values = {};
  for (const line of serialized.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}
