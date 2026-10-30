// Minimal stdio MCP server for tests: one `echo` tool. Newline-delimited JSON-RPC 2.0 on stdin/stdout.
export {};
const tools = [
	{
		name: "echo",
		description: "Echo the given text back, prefixed with the ECHO_PREFIX env value.",
		inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	},
];

function reply(id: unknown, body: { result?: unknown; error?: { code: number; message: string } }): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += new TextDecoder().decode(chunk);
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (!line) continue;
		const msg = JSON.parse(line) as { id?: unknown; method?: string; params?: { protocolVersion?: string; arguments?: { text?: string } } };
		if (msg.id === undefined) continue; // notification
		switch (msg.method) {
			case "initialize":
				reply(msg.id, {
					result: {
						protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "echo-mcp", version: "1.0.0" },
					},
				});
				break;
			case "tools/list":
				reply(msg.id, { result: { tools } });
				break;
			case "tools/call":
				reply(msg.id, { result: { content: [{ type: "text", text: `${process.env.ECHO_PREFIX ?? ""}${msg.params?.arguments?.text ?? ""}` }] } });
				break;
			case "ping":
				reply(msg.id, { result: {} });
				break;
			default:
				reply(msg.id, { error: { code: -32601, message: `Method not found: ${msg.method}` } });
		}
	}
}
