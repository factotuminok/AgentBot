import { MCP_TRANSPORTS, type McpRow, type McpServerInput, type McpTransport, type OmpSaveRequest, type OmpSettingInfo, type OmpView, type SecretKeyInput, type SettingRow } from "../shared/adminOmp";
import { field, rowIndices } from "./forms";

/**
 * The omp page form (AGT-20, AGT-21) ↔ the admin API's save request. The orchestrator parses the values with omp's own
 * parser and fills in blank write-only values from what it stores; this module only reads and echoes the form.
 */

/** Everything the omp page form renders; holds no credential, env or header values. */
export interface OmpFormState {
	settings: SettingRow[];
	newSetting: { id: string; value: string };
	servers: McpRow[];
}

/** Form text for a setting value: JSON for arrays and records, plain text otherwise. */
export function settingText(info: OmpSettingInfo | undefined, value: unknown): string {
	if (typeof value === "string") return value;
	if (info?.type === "array" || info?.type === "record") return JSON.stringify(value, null, 2);
	return value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}

function isTransport(text: string): text is McpTransport {
	return (MCP_TRANSPORTS as readonly string[]).includes(text);
}

/** Submitted settings: each kept row with an id, the add row last. */
function settingEntries(form: FormData): { id: string; value: string }[] {
	const entries: { id: string; value: string }[] = [];
	for (const i of rowIndices(form, "setting")) {
		if (form.has(`setting.${i}.remove`)) continue;
		const id = field(form, `setting.${i}.id`).trim();
		if (id) entries.push({ id, value: field(form, `setting.${i}.value`) });
	}
	const newId = field(form, "setting.new.id").trim();
	if (newId) entries.push({ id: newId, value: field(form, "setting.new.value") });
	return entries;
}

/** Kept key/value rows of `mcp.<i>.<kind>.<j>`; values as typed ("" = keep the stored value). */
function keyValueRows(form: FormData, prefix: string): SecretKeyInput[] {
	const rows: SecretKeyInput[] = [];
	for (const j of rowIndices(form, prefix)) {
		if (form.has(`${prefix}.${j}.remove`)) continue;
		const key = field(form, `${prefix}.${j}.key`).trim();
		if (key) rows.push({ key, value: field(form, `${prefix}.${j}.value`) });
	}
	return rows;
}

/** Server fieldsets that are not marked for deletion and not entirely blank. */
function submittedServers(form: FormData): McpServerInput[] {
	const servers: McpServerInput[] = [];
	for (const i of rowIndices(form, "mcp")) {
		if (form.has(`mcp.${i}.delete`)) continue;
		const text = (name: string) => field(form, `mcp.${i}.${name}`).trim();
		const type = text("type");
		const server: McpServerInput = {
			name: text("name"),
			type: isTransport(type) ? type : "stdio",
			enabled: form.has(`mcp.${i}.enabled`),
			instructions: form.has(`mcp.${i}.instructions`),
			timeout: text("timeout"),
			command: text("command"),
			args: field(form, `mcp.${i}.args`)
				.split("\n")
				.map(arg => arg.trim())
				.filter(Boolean),
			cwd: text("cwd"),
			url: text("url"),
			env: keyValueRows(form, `mcp.${i}.env`),
			headers: keyValueRows(form, `mcp.${i}.header`),
		};
		const blank = !server.name && !server.timeout && !server.command && !server.args.length && !server.cwd && !server.url && !server.env.length && !server.headers.length;
		if (!blank) servers.push(server);
	}
	return servers;
}

/** The omp page form as a save request. */
export function ompSaveRequestFromForm(form: FormData): OmpSaveRequest {
	return { settings: settingEntries(form), servers: submittedServers(form) };
}

/** Form state for the stored configuration. */
export function ompFormFromView(view: OmpView): OmpFormState {
	return { settings: view.settings, newSetting: { id: "", value: "" }, servers: view.servers };
}

/** Form state echoing a rejected submission; credential, env and header values are dropped. */
export function ompFormFromSubmission(form: FormData, view: OmpView): OmpFormState {
	const reference = new Map(view.reference.map(info => [info.id, info]));
	const storedSettings = new Map(view.settings.map(row => [row.id, row]));
	const storedServers = new Map(view.servers.map(row => [row.name, row]));
	const echo = (id: string, text: string): SettingRow => {
		const credential = reference.get(id)?.credential ?? false;
		return { id, value: credential ? "" : text, credentialSet: credential && storedSettings.has(id) };
	};
	const request = ompSaveRequestFromForm(form);
	const newId = field(form, "setting.new.id").trim();
	// The add row is the last entry when it has an id.
	const rows = newId ? request.settings.slice(0, -1) : request.settings;
	const servers = request.servers.map(({ env, headers, args, ...server }): McpRow => {
		const prev = storedServers.get(server.name);
		const isSet = (rows: SecretKeyInput[], stored: McpRow["env"] | undefined) => rows.map(({ key }) => ({ key, set: !!stored?.some(row => row.key === key) }));
		return { ...server, args: args.join("\n"), existing: !!prev, env: isSet(env, prev?.env), headers: isSet(headers, prev?.headers) };
	});
	return {
		settings: rows.map(row => echo(row.id, row.value)),
		newSetting: newId ? echo(newId, field(form, "setting.new.value")) : { id: "", value: "" },
		servers,
	};
}
