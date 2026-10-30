import { type CustomTool, zod } from "@oh-my-pi/pi-coding-agent";

export type TodoStatus = "pending" | "in_progress" | "completed" | "failed";

export interface TodoItem {
	content: string;
	status: TodoStatus;
}

export const TODO_TOOL = "update_todos";

/** Prepended to every prompt DevForge sends to omp, so each run keeps a todo list the Discord thread mirrors. */
export const TODO_INSTRUCTION = [
	`Keep a todo list for this request with the \`${TODO_TOOL}\` tool; DevForge shows it live in the Discord thread.`,
	"- Before you start working, call it with every step you plan to take, all `pending`.",
	"- Mark a step `in_progress` when you start it and `completed` only when it actually succeeded; add, reword or drop steps when your plan changes.",
	"- Mark a step `failed` when it did not work or could not be done: a command or check failed, a tool or dependency is missing, or an earlier failure kept you from doing it. Never mark such a step `completed`.",
	"- Before you call `yield`, update the list so no step is left `pending` or `in_progress`.",
	"- Always send the complete list, in order. Keep each step to one short line.",
].join("\n");

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

/** `update_todos`: replaces the run's todo list and reports it to `onChange`. omp's own `todo` tool is off in yield sessions. */
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
