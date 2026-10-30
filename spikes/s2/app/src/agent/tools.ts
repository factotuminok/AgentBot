import { type CustomTool, zod } from "@oh-my-pi/pi-coding-agent";

const createIssueParams = zod.object({
	title: zod.string().describe("Issue title: short and specific."),
	body: zod
		.string()
		.describe("Issue body in Markdown: self-contained context, the requested change, and acceptance criteria."),
});

/**
 * `create_issue` for chat sessions: files an issue without the trigger label; the human hands it to DevForge from Discord.
 * `file` runs in the main process (GitHub credentials and the Discord thread live there); the session only sees its result.
 */
export function createIssueTool(opts: {
	repo: string;
	file(title: string, body: string): Promise<{ number: number; url: string }>;
}): CustomTool<typeof createIssueParams> {
	return {
		name: "create_issue",
		label: "Create Issue",
		description: `Create a GitHub issue in ${opts.repo}. Use only when the user asks for work to be filed. The issue must be complete and self-contained.`,
		parameters: createIssueParams,
		approval: "write",
		async execute(_toolCallId, params) {
			const issue = await opts.file(params.title, params.body);
			return { content: [{ type: "text", text: issue.url }], details: issue };
		},
	};
}
