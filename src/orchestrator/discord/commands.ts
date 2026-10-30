import {
	type APIApplicationCommandBasicOption,
	type APIApplicationCommandSubcommandOption,
	ApplicationCommandOptionType,
	ApplicationCommandType,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";

/** Longest `request`/`prompt` accepted by `/work issue` and `/work plan` (requirements §7.2). */
export const MAX_REQUEST_LENGTH = 4000;

/**
 * DSC-09, DSC-33: autocompleted from the available repositories. Declared optional because a watch channel defaults it to
 * that channel's repository; the bot requires it in the work channel.
 */
function repoOption(): APIApplicationCommandBasicOption {
	return {
		type: ApplicationCommandOptionType.String,
		name: "repo",
		description: "Repository (owner/name); defaults to this watch channel's repository",
		required: false,
		autocomplete: true,
	};
}

function text(name: string, description: string, maxLength?: number): APIApplicationCommandBasicOption {
	return { type: ApplicationCommandOptionType.String, name, description, required: true, ...(maxLength ? { max_length: maxLength } : {}) };
}

function sub(name: string, description: string, options: APIApplicationCommandBasicOption[] = []): APIApplicationCommandSubcommandOption {
	return { type: ApplicationCommandOptionType.Subcommand, name, description, options };
}

/**
 * The guild's complete command list (DSC-01): exactly `/work` and `/ask`, replaced at every ready event.
 * `/ask` is top level so a server admin can hide `/work` in ask-only channels while `/ask` stays visible (DSC-05).
 */
export function commandDefinitions(agentName: string): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
	const work: RESTPostAPIChatInputApplicationCommandsJSONBody = {
		type: ApplicationCommandType.ChatInput,
		name: "work",
		description: `Assign work to ${agentName}`.slice(0, 100),
		options: [
			sub("start", `Hand an existing issue to ${agentName}`.slice(0, 100), [
				{ type: ApplicationCommandOptionType.Integer, name: "issue", description: "Issue number", required: true, min_value: 1 },
				repoOption(),
			]),
			sub("issue", `Describe work; ${agentName} drafts a GitHub issue, labels it and starts on it`.slice(0, 100), [
				text("request", "What should be done, in your own words", MAX_REQUEST_LENGTH),
				repoOption(),
			]),
			sub("plan", "Plan work in a new thread; then approve, execute, refine or reject the plan", [
				text("prompt", "What should be planned, in your own words", MAX_REQUEST_LENGTH),
				repoOption(),
			]),
			sub("ask", "Ask a question about a repository in a new thread", [text("prompt", "Question or request"), repoOption()]),
			sub("watch", "Watch a repository: labelled issues start in its own channel", [repoOption()]),
			sub("unwatch", "Stop watching a repository; its channel is kept", [repoOption()]),
			sub("status", `List active ${agentName} work`.slice(0, 100)),
			sub("cancel", "Cancel the issue or plan in this thread"),
		],
	};
	const file = (name: string, description: string): APIApplicationCommandBasicOption => ({
		type: ApplicationCommandOptionType.Attachment,
		name,
		description,
		required: false,
	});
	const ask: RESTPostAPIChatInputApplicationCommandsJSONBody = {
		type: ApplicationCommandType.ChatInput,
		name: "ask",
		description: "Ask a question in a new thread (ask-only channels)",
		options: [text("prompt", "Question or request"), file("file", "A file for the agent to use"), file("file2", "Another file"), file("file3", "Another file")],
	};
	return [work, ask];
}
