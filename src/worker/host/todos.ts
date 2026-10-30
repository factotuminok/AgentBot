import { type CustomTool, zod } from "@oh-my-pi/pi-coding-agent";
import type { TodoItem } from "../../shared/agent";

/**
 * `update_todos` (AGT-16). The instruction to use it is part of the prompt the orchestrator builds
 * (`runPrompt` in `src/orchestrator/engine/prompts.ts`); the host only provides the tool.
 */
export const TODO_TOOL = "update_todos";

const todoParams = zod.object({
	todos: zod
		.array(
			zod.object({
				content: zod.string().trim().min(1).describe("The step, one short line."),
				status: zod.enum(["pending", "in_progress", "completed", "failed"]),
			}),
		)
		.max(50)
		.describe("The complete todo list, in order; replaces the previous list."),
});

/** Replaces the run's todo list and reports it to `onChange`. omp's own `todo` tool is off in yield sessions. */
export function createTodoTool(onChange: (todos: TodoItem[]) => void): CustomTool<typeof todoParams> {
	return {
		name: TODO_TOOL,
		label: "Update Todos",
		description:
			"Replace your todo list for this request with the complete, ordered list of steps and their status: pending, in_progress, completed (it succeeded) or failed (it did not work or could not be done). The list is shown live to the people following your work.",
		parameters: todoParams,
		approval: "read",
		// Custom tools default to "discoverable", which unrestricted (implement) sessions mount under `xd://`; keep it a
		// top-level tool so the instruction's tool name works as-is.
		loadMode: "essential",
		async execute(_toolCallId, params) {
			const todos = params.todos.map(({ content, status }) => ({ content, status }));
			onChange(todos);
			const done = todos.filter(todo => todo.status === "completed").length;
			const failed = todos.filter(todo => todo.status === "failed").length;
			const text = `Todo list updated: ${done}/${todos.length} completed${failed ? `, ${failed} failed` : ""}.`;
			return { content: [{ type: "text", text }], details: { todos } };
		},
	};
}
