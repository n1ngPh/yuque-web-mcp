const baseUrl = process.env.MCP_URL || "http://127.0.0.1:18080/mcp";
const token = process.env.MCP_BEARER_TOKEN;
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
      clientInfo: { name: "yuque-web-mcp-smoke", version: "1.0.0" },
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
if (count !== 29)
  throw new Error(`expected 29 tools, received ${String(count)}`);
const allDocs = payload.result?.tools?.find(
  (tool) => tool.name === "yuque_list_all_docs",
);
if (!allDocs?.description?.includes("offset+limit")) {
  throw new Error("tools/list is missing the document pagination guidance");
}
process.stdout.write(
  `${JSON.stringify({ status: "ok", tool_count: count, instructions: "present" })}\n`,
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
