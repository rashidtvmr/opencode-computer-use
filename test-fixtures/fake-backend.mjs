import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const tools = [
  {
    name: "list_apps",
    description: "List apps",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_app_state",
    description: "Get app state",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "click",
    description: "Click",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "type_text",
    description: "Type text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-computer-use", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const text = name === "list_apps"
      ? '[{"id":"com.example.Text","displayName":"Text"}]'
      : `called:${name}`;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [
          { type: "text", text },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        isError: false,
        _meta: { received: message.params?.arguments },
      },
    });
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
