import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	CREDENTIALS_ON_OMP_PAGE,
	SECRET_NOT_SET,
	SECRET_SET,
	SECRETS_ON_SETTINGS_PAGE,
	WORKSPACE_OMP,
	WORKSPACE_SETTINGS,
	type WorkspaceConflict,
	type WorkspaceFile,
	type WorkspaceLocked,
	type WorkspaceManifest,
	type WorkspaceProblem,
	type WorkspaceRejection,
	type WorkspaceSaveResult,
	type WorkspaceSchemas,
} from "../../shared/adminWorkspace";
import type { SettingsSaveResponse } from "../../shared/adminApi";
import { ConfigError, configJsonSchema, parseConfig, type Secrets, type Settings } from "../../shared/config";
import { errorMessage, log } from "../../shared/log";
import { mcpServerJsonSchema, type OmpConfig, OmpConfigError, parseOmpConfig, parseSettingValue, type SettingInfo } from "../../shared/ompconfig";
import { listOmpAssetFiles, OmpAssetError, removeOmpAsset, removeSkillFile, saveAgentFile, saveSkillFile } from "../store/ompAssets";
import type { Vault } from "../store/vault";
import { actingAdmin, type AdminRoutes, fail } from "./http";
import { ompSettings, serverMaps, settingText, stored, storedOmpConfig } from "./omp";
import { type SettingsSaveDeps, SettingsRejected, storeSettings } from "./settingsSave";

/**
 * `/internal/admin/workspace*`: the config workspace (WEB-25 to WEB-29); the contract is in `src/shared/adminWorkspace.ts`.
 * Every write goes through the same validation and storage as the matching web page: settings.json through
 * `storeSettings`, omp.json through omp's own setting parser and `parseOmpConfig`, skills and agents through the AGT-25
 * rules of `ompAssets.ts`. Writes are handled one at a time, so a revision check always sees the previous write.
 */

export interface WorkspaceRoutesDeps extends SettingsSaveDeps {
	vault: Pick<Vault, "isInitialized" | "isUnlocked" | "readSettings" | "writeSettings" | "readOmpConfig" | "writeOmpConfig">;
	/** `env.ompDir`: the skills and agents. */
	ompDir: string;
}

const LOCKED_MESSAGE = "Settings are locked; log in to unlock them.";
const PLACEHOLDER_SCHEMA = { enum: [SECRET_SET, SECRET_NOT_SET] };
const SECRET_KEYS = ["discordToken", "githubAppPrivateKey", "providerKeys"];

/** A write the workspace refuses; `body` is the contract's answer. */
class WorkspaceRefusal extends Error {
	constructor(
		readonly status: 400 | 409,
		readonly body: WorkspaceRejection | WorkspaceConflict | WorkspaceLocked,
	) {
		super(body.reason);
	}
}

const invalid = (problems: WorkspaceProblem[]) => new WorkspaceRefusal(400, { ok: false, reason: "invalid", problems });

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A file's revision (contract): sha256 hex of its rendered bytes. */
function revisionOf(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

const mask = (value: string | undefined): string => (value ? SECRET_SET : SECRET_NOT_SET);

/** 1-based line of the first syntax error in `text`, which `JSON.parse` refused without saying where. */
function jsonErrorLine(text: string): number {
	let i = 0;
	const literal = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
	const space = () => {
		while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
	};
	const expect = (char: string) => {
		if (text[i] !== char) throw i;
		i++;
	};
	const string = () => {
		expect('"');
		while (text[i] !== '"') {
			if (i >= text.length || text.charCodeAt(i) < 0x20) throw i;
			if (text[i] === "\\") {
				i++;
				if (text[i] === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) i += 4;
				else if (!'"\\/bfnrt'.includes(text[i] ?? "u")) throw i;
			}
			i++;
		}
		i++;
	};
	const value = (): void => {
		space();
		const close = text[i] === "{" ? "}" : text[i] === "[" ? "]" : undefined;
		if (!close) {
			if (text[i] === '"') return string();
			literal.lastIndex = i;
			if (!literal.test(text)) throw i;
			i = literal.lastIndex;
			return;
		}
		i++;
		space();
		if (text[i] === close) {
			i++;
			return;
		}
		for (;;) {
			if (close === "}") {
				space();
				string();
				space();
				expect(":");
			}
			value();
			space();
			if (text[i] !== ",") return expect(close);
			i++;
		}
	};
	try {
		value();
		space();
		if (i < text.length) throw i;
	} catch (pos) {
		if (typeof pos !== "number") throw pos;
		return text.slice(0, pos).split("\n").length;
	}
	return 1;
}

/** The JSON object in `bytes`; a syntax error is reported at its line. */
function parseJsonFile(name: string, bytes: Uint8Array): Record<string, unknown> {
	const text = new TextDecoder().decode(bytes);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (err) {
		throw invalid([{ message: `${name} is not valid JSON: ${errorMessage(err)}`, line: jsonErrorLine(text) }]);
	}
	if (!isObject(value)) throw invalid([{ message: `${name} must be a JSON object.`, line: 1 }]);
	return value;
}

/** Problems for keys of `given` that validation dropped from `parsed` (zod strips unknown keys): a typo must not vanish silently. */
function droppedKeys(given: unknown, parsed: unknown, path: (string | number)[], problems: WorkspaceProblem[]): void {
	if (!isObject(given) || !isObject(parsed)) return;
	for (const [key, value] of Object.entries(given)) {
		const at = [...path, key];
		if (Object.hasOwn(parsed, key)) droppedKeys(value, parsed[key], at, problems);
		else problems.push({ message: `Unknown setting "${at.join(".")}".`, jsonPath: at });
	}
}

/** settings.json: the config with its defaults, then `secrets` as placeholders only (WEB-25). */
function renderSettings({ config, secrets }: Settings): string {
	const providerKeys = Object.keys(secrets.providerKeys).sort();
	const file = {
		...config,
		secrets: {
			discordToken: mask(secrets.discordToken),
			githubAppPrivateKey: mask(secrets.githubAppPrivateKey),
			providerKeys: Object.fromEntries(providerKeys.map(id => [id, mask(secrets.providerKeys[id])])),
		},
	};
	return `${JSON.stringify(file, null, "\t")}\n`;
}

/**
 * The secrets a settings.json stands for: `<set>` is the stored value, `<not set>` or a missing entry none (a provider
 * key is deleted, a required secret fails validation). Anything else is refused: secrets are set on the Settings page.
 */
function fileSecrets(given: unknown, previous: Secrets | undefined, problems: WorkspaceProblem[]): Record<string, unknown> {
	if (given !== undefined && !isObject(given)) {
		problems.push({ message: "secrets must be an object.", jsonPath: ["secrets"] });
		return {};
	}
	const entries = given ?? {};
	const resolve = (value: unknown, current: string | undefined, jsonPath: string[]): string | undefined => {
		if (value === undefined || value === SECRET_NOT_SET) return undefined;
		if (value === SECRET_SET && current !== undefined) return current;
		problems.push({ message: SECRETS_ON_SETTINGS_PAGE, jsonPath });
		return undefined;
	};
	for (const key of Object.keys(entries)) {
		if (!SECRET_KEYS.includes(key)) problems.push({ message: `Unknown setting "secrets.${key}".`, jsonPath: ["secrets", key] });
	}
	const providerKeys: [string, string][] = [];
	if (entries.providerKeys !== undefined && !isObject(entries.providerKeys)) {
		problems.push({ message: "secrets.providerKeys must be an object.", jsonPath: ["secrets", "providerKeys"] });
	} else {
		for (const [id, value] of Object.entries(entries.providerKeys ?? {})) {
			const key = resolve(value, stored(previous?.providerKeys, id), ["secrets", "providerKeys", id]);
			if (key !== undefined) providerKeys.push([id, key]);
		}
	}
	return {
		discordToken: resolve(entries.discordToken, previous?.discordToken, ["secrets", "discordToken"]),
		githubAppPrivateKey: resolve(entries.githubAppPrivateKey, previous?.githubAppPrivateKey, ["secrets", "githubAppPrivateKey"]),
		providerKeys: Object.fromEntries(providerKeys),
	};
}

/** A flag whose value is a credential: `--api-key <value>` or `--api-key=<value>` (F13). */
const SECRET_FLAG = /^--?[\w.-]*(?:key|token|secret|password|passwd|auth|credentials?)$/i;
const URL_CREDENTIALS =
	"Credentials in an MCP server URL (user info or query) are set on the omp page; where the server allows it, send them as headers.";
const ARG_CREDENTIALS = "Credentials in MCP server arguments are set on the omp page; where the server allows it, pass them through env.";

/** F13: stdio args with credential values as `<set>`: the arg after a secret-looking flag, and the value of `--flag=value`. */
function maskArgs(args: readonly string[]): string[] {
	return args.map((arg, i) => {
		const eq = arg.indexOf("=");
		if (eq > 0 && SECRET_FLAG.test(arg.slice(0, eq))) return `${arg.slice(0, eq + 1)}${SECRET_SET}`;
		return i > 0 && SECRET_FLAG.test(args[i - 1]!) ? SECRET_SET : arg;
	});
}

/** F13: an MCP server URL with its user info and query values as `<set>`; unchanged when it has neither. */
function maskUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return raw;
	}
	if (!url.username && !url.password && !url.search) return raw;
	const auth = url.username || url.password ? `${SECRET_SET}${url.password ? `:${SECRET_SET}` : ""}@` : "";
	const query = url.search ? `?${[...url.searchParams.keys()].map(key => `${encodeURIComponent(key)}=${SECRET_SET}`).join("&")}` : "";
	return `${url.protocol}//${auth}${url.host}${url.pathname}${query}${url.hash}`;
}

/** omp.json: overrides and MCP servers with credential settings, env/header values, URL credentials and credential args as placeholders (WEB-25). */
function renderOmp(config: OmpConfig): string {
	const { byId } = ompSettings();
	const maskMap = (map: Record<string, string> | undefined) => map && Object.fromEntries(Object.entries(map).map(([key, value]) => [key, mask(value)]));
	const file = {
		settings: Object.fromEntries(Object.entries(config.settings).map(([id, value]) => [id, byId.get(id)?.credential ? SECRET_SET : value])),
		mcpServers: Object.fromEntries(
			Object.entries(config.mcpServers).map(([name, server]) => [
				name,
				"url" in server
					? { ...server, url: maskUrl(server.url), headers: maskMap(server.headers) }
					: { ...server, ...(server.args ? { args: maskArgs(server.args) } : {}), env: maskMap(server.env) },
			]),
		),
	};
	return `${JSON.stringify(file, null, "\t")}\n`;
}

/**
 * F13: the URL an omp.json entry stands for: the stored one when the stored URL's masked form was sent back, the given
 * one when it carries no credentials; undefined (refused) for credentials in clear or a placeholder that doesn't match.
 */
function unmaskUrl(given: string, kept: string | undefined): string | undefined {
	if (kept !== undefined && given === maskUrl(kept)) return kept;
	return given.includes(SECRET_SET) || maskUrl(given) !== given ? undefined : given;
}

/** F13: like `unmaskUrl` per argument, matched by position against the stored args. */
function unmaskArgs(given: readonly unknown[], kept: readonly string[], problems: WorkspaceProblem[], jsonPath: string[]): unknown[] {
	const strings = given.map(arg => (typeof arg === "string" ? arg : ""));
	const maskedGiven = maskArgs(strings);
	const maskedKept = maskArgs(kept);
	return given.map((arg, i) => {
		if (typeof arg !== "string") return arg;
		if (arg.includes(SECRET_SET)) {
			if (maskedKept[i] === arg && kept[i] !== arg) return kept[i];
		} else if (maskedGiven[i] === arg) return arg;
		problems.push({ message: ARG_CREDENTIALS, jsonPath: [...jsonPath, String(i)] });
		return arg;
	});
}

/**
 * The configuration an omp.json stands for, validated as the omp page validates it (AGT-20, AGT-21): each setting
 * through omp's own parser, then `parseOmpConfig`. `<set>` keeps a stored credential or env/header value; `<not set>`
 * drops a credential setting and leaves an env/header value empty; any other value there is refused. A server URL or
 * stdio argument rendered with `<set>` keeps the stored one when sent back unchanged; credentials typed there in clear
 * are refused (F13).
 */
function ompConfigFromFile(file: Record<string, unknown>, previous: OmpConfig): OmpConfig {
	const { byId } = ompSettings();
	const problems: WorkspaceProblem[] = [];
	const { settings: givenSettings = {}, mcpServers: givenServers = {}, ...rest } = file;
	for (const key of Object.keys(rest)) problems.push({ message: `Unknown key "${key}": omp.json holds settings and mcpServers.`, jsonPath: [key] });
	const settings: [string, unknown][] = [];
	if (!isObject(givenSettings)) problems.push({ message: "settings must be an object.", jsonPath: ["settings"] });
	else {
		for (const [id, value] of Object.entries(givenSettings)) {
			const info = byId.get(id);
			if (info?.credential) {
				const kept = stored(previous.settings, id);
				if (value === SECRET_SET && kept !== undefined) settings.push([id, kept]);
				else if (value !== SECRET_NOT_SET) problems.push({ message: CREDENTIALS_ON_OMP_PAGE, jsonPath: ["settings", id] });
				continue;
			}
			try {
				settings.push([id, parseSettingValue(id, settingText(info, value))]);
			} catch (err) {
				if (!(err instanceof OmpConfigError)) throw err;
				problems.push({ message: err.message, jsonPath: err.path });
			}
		}
	}
	const servers: [string, unknown][] = [];
	if (!isObject(givenServers)) problems.push({ message: "mcpServers must be an object.", jsonPath: ["mcpServers"] });
	else {
		for (const [name, server] of Object.entries(givenServers)) {
			if (!isObject(server)) {
				servers.push([name, server]);
				continue;
			}
			const previousServer = stored(previous.mcpServers, name);
			const previousMaps = serverMaps(previousServer);
			const entry = { ...server };
			if (typeof server.url === "string") {
				const url = unmaskUrl(server.url, previousServer && "url" in previousServer ? previousServer.url : undefined);
				if (url === undefined) problems.push({ message: URL_CREDENTIALS, jsonPath: ["mcpServers", name, "url"] });
				else entry.url = url;
			}
			if (Array.isArray(server.args)) {
				const keptArgs = previousServer && !("url" in previousServer) ? (previousServer.args ?? []) : [];
				entry.args = unmaskArgs(server.args, keptArgs, problems, ["mcpServers", name, "args"]);
			}
			for (const field of ["env", "headers"] as const) {
				const values = server[field];
				if (!isObject(values)) continue;
				entry[field] = Object.fromEntries(
					Object.entries(values).map(([key, value]) => {
						const kept = stored(previousMaps[field], key);
						if (value === SECRET_SET && kept !== undefined) return [key, kept];
						if (value !== SECRET_NOT_SET) problems.push({ message: CREDENTIALS_ON_OMP_PAGE, jsonPath: ["mcpServers", name, field, key] });
						return [key, ""];
					}),
				);
			}
			servers.push([name, entry]);
		}
	}
	if (problems.length) throw invalid(problems);
	let config: OmpConfig;
	try {
		config = parseOmpConfig({ settings: Object.fromEntries(settings), mcpServers: Object.fromEntries(servers) });
	} catch (err) {
		if (err instanceof OmpConfigError) throw invalid([{ message: err.message, jsonPath: err.path }]);
		throw err;
	}
	if (isObject(givenServers)) droppedKeys(givenServers, config.mcpServers, ["mcpServers"], problems);
	if (problems.length) throw invalid(problems);
	return config;
}

/** JSON Schema of one omp setting's value in omp.json. */
function settingSchema(info: SettingInfo): Record<string, unknown> {
	const description = info.description ?? info.label;
	const doc = { ...(description ? { description } : {}), ...(info.credential || info.default === undefined ? {} : { default: info.default }) };
	if (info.credential) return { ...doc, ...PLACEHOLDER_SCHEMA };
	switch (info.type) {
		case "enum":
			return { ...doc, enum: [...(info.enumValues ?? [])] };
		case "record":
			return { ...doc, type: "object" };
		default:
			return { ...doc, type: info.type };
	}
}

/** Closes every object schema that lists its properties: the workspace refuses unknown keys. */
function closed(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(closed);
	if (!isObject(node)) return node;
	const out = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, closed(value)]));
	if (isObject(out.properties) && !("additionalProperties" in out)) out.additionalProperties = false;
	return out;
}

function workspaceSchemas(): WorkspaceSchemas {
	const config = configJsonSchema();
	const secrets = {
		type: "object",
		description: "Secrets are set on the Settings page; here they only show whether they are set.",
		properties: { discordToken: PLACEHOLDER_SCHEMA, githubAppPrivateKey: PLACEHOLDER_SCHEMA, providerKeys: { type: "object", additionalProperties: PLACEHOLDER_SCHEMA } },
		additionalProperties: false,
	};
	const server = mcpServerJsonSchema();
	// Embedded below, so not a schema resource of its own.
	delete server.$schema;
	// AGT-21: env and header values are write-only, so the file holds placeholders only.
	const maskedServer = closed({
		...server,
		anyOf: (Array.isArray(server.anyOf) ? server.anyOf : []).map(member => {
			if (!isObject(member) || !isObject(member.properties)) return member;
			const properties = { ...member.properties };
			for (const field of ["env", "headers"]) {
				const map = properties[field];
				if (isObject(map)) properties[field] = { ...map, additionalProperties: PLACEHOLDER_SCHEMA };
			}
			return { ...member, properties };
		}),
	});
	const settings = ompSettings().list.filter(info => !info.locked);
	return {
		settings: closed({ ...config, properties: { ...(isObject(config.properties) ? config.properties : {}), secrets } }),
		omp: {
			$schema: config.$schema,
			type: "object",
			properties: {
				settings: { type: "object", description: "omp setting overrides (AGT-20); pinned settings can't be overridden.", properties: Object.fromEntries(settings.map(info => [info.id, settingSchema(info)])), additionalProperties: false },
				mcpServers: { type: "object", description: "MCP servers (AGT-21) by name.", propertyNames: { pattern: "^[A-Za-z0-9_-]{1,48}$" }, additionalProperties: maskedServer },
			},
			additionalProperties: false,
		},
	};
}

export function createWorkspaceRoutes(deps: WorkspaceRoutesDeps): AdminRoutes {
	const { vault, ompDir } = deps;
	/** Skill and agent revisions by path, reused while the file's size and mtime stay the same. */
	const hashes = new Map<string, { size: number; mtimeMs: number; revision: string }>();
	let writes: Promise<unknown> = Promise.resolve();

	function requireUnlocked(): void {
		if (!vault.isInitialized() || !vault.isUnlocked()) throw new WorkspaceRefusal(409, { ok: false, reason: "locked", message: LOCKED_MESSAGE });
	}

	/** Stored settings; undefined when none are saved or they no longer validate (the engine reports that). */
	function storedSettings(): Settings | undefined {
		try {
			return vault.readSettings();
		} catch (err) {
			log("debug", "workspace: stored settings unreadable", { error: errorMessage(err) });
			return undefined;
		}
	}

	function settingsText(): string | undefined {
		const settings = storedSettings();
		return settings && renderSettings(settings);
	}

	async function assetFiles(): Promise<Map<string, WorkspaceFile>> {
		const files = new Map<string, WorkspaceFile>();
		for (const { path, size, mtimeMs } of await listOmpAssetFiles(ompDir)) {
			let cached = hashes.get(path);
			if (cached?.size !== size || cached.mtimeMs !== mtimeMs) {
				try {
					cached = { size, mtimeMs, revision: revisionOf(await readFile(join(ompDir, path))) };
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw err;
				}
				hashes.set(path, cached);
			}
			files.set(path, { path, revision: cached.revision, size });
		}
		for (const path of hashes.keys()) if (!files.has(path)) hashes.delete(path);
		return files;
	}

	async function manifest(): Promise<WorkspaceManifest> {
		const isLocked = !vault.isInitialized() || !vault.isUnlocked();
		const files: WorkspaceFile[] = [];
		if (!isLocked) {
			const rendered = [[WORKSPACE_SETTINGS, settingsText()], [WORKSPACE_OMP, renderOmp(storedOmpConfig(vault).config)]] as const;
			for (const [path, text] of rendered) if (text !== undefined) files.push({ path, revision: revisionOf(text), size: Buffer.byteLength(text) });
		}
		files.push(...(await assetFiles()).values());
		const etag = revisionOf(JSON.stringify([isLocked, files.map(f => [f.path, f.revision])]));
		return { etag, locked: isLocked, files };
	}

	async function read(path: string): Promise<string | Uint8Array<ArrayBuffer> | undefined> {
		if (path === WORKSPACE_SETTINGS) {
			requireUnlocked();
			return settingsText();
		}
		if (path === WORKSPACE_OMP) {
			requireUnlocked();
			return renderOmp(storedOmpConfig(vault).config);
		}
		if (!(await assetFiles()).has(path)) return undefined;
		try {
			return await readFile(join(ompDir, path));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw err;
		}
	}

	/** Refuses the write unless `base` is the current revision ("" for a file that doesn't exist). */
	function checkBase(current: string | undefined, base: string): void {
		if ((current ?? "") !== base) throw new WorkspaceRefusal(409, { ok: false, reason: "conflict", revision: current ?? "" });
	}

	async function putSettings(bytes: Uint8Array, base: string): Promise<WorkspaceSaveResult> {
		requireUnlocked();
		const revision = () => {
			const text = settingsText();
			return text === undefined ? undefined : revisionOf(text);
		};
		checkBase(revision(), base);
		const { secrets: givenSecrets, ...config } = parseJsonFile(WORKSPACE_SETTINGS, bytes);
		const problems: WorkspaceProblem[] = [];
		const secrets = fileSecrets(givenSecrets, storedSettings()?.secrets, problems);
		try {
			droppedKeys(config, parseConfig(config), [], problems);
		} catch (err) {
			if (!(err instanceof ConfigError)) throw err;
			problems.push(...err.issues.map(({ path, message }) => ({ message, jsonPath: path })));
		}
		if (problems.length) throw invalid(problems);
		let saved: SettingsSaveResponse;
		try {
			// The channel check waits on Discord; a Settings page save may land meanwhile.
			saved = await storeSettings(deps, { config, secrets }, () => checkBase(revision(), base));
		} catch (err) {
			if (err instanceof SettingsRejected) throw invalid(err.issues.map(({ path, message }) => ({ message, jsonPath: path })));
			throw err;
		}
		const text = settingsText() ?? "";
		return { ok: true, revision: revisionOf(text), rewritten: !Buffer.from(text).equals(bytes), ...saved };
	}

	function putOmp(bytes: Uint8Array, base: string): WorkspaceSaveResult {
		requireUnlocked();
		const previous = storedOmpConfig(vault).config;
		checkBase(revisionOf(renderOmp(previous)), base);
		const config = ompConfigFromFile(parseJsonFile(WORKSPACE_OMP, bytes), previous);
		vault.writeOmpConfig(config);
		const text = renderOmp(config);
		return { ok: true, revision: revisionOf(text), rewritten: !Buffer.from(text).equals(bytes) };
	}

	/** Skill or agent: `skills/<name>/<file>` (file "" for the folder) or `agents/<name>.md`. */
	function assetTarget(path: string): { kind: "skill"; name: string; file: string } | { kind: "agent"; name: string } {
		const skill = /^skills\/([^/]+)\/(.*)$/.exec(path);
		if (skill) return { kind: "skill", name: skill[1]!, file: skill[2]! };
		const agent = /^agents\/([^/]+)\.md$/.exec(path);
		if (agent) return { kind: "agent", name: agent[1]! };
		throw invalid([{ message: `"${path}" is not a workspace file: use settings.json, omp.json, skills/<name>/<file> or agents/<name>.md.` }]);
	}

	async function putAsset(path: string, bytes: Uint8Array, base: string): Promise<WorkspaceSaveResult> {
		const target = assetTarget(path);
		if (target.kind === "skill" && !target.file) throw invalid([{ message: "A folder can't be written; save a file inside it." }]);
		checkBase((await assetFiles()).get(path)?.revision, base);
		try {
			if (target.kind === "skill") await saveSkillFile(ompDir, target.name, target.file, bytes);
			else await saveAgentFile(ompDir, target.name, bytes);
		} catch (err) {
			if (!(err instanceof OmpAssetError)) throw err;
			throw invalid([err.line === undefined ? { message: err.message } : { message: err.message, line: err.line }]);
		}
		return { ok: true, revision: revisionOf(bytes), rewritten: false };
	}

	/** Deletes a skill file, a skill folder or an agent; true when something was there. */
	async function deleteAsset(path: string, base: string): Promise<boolean> {
		const target = assetTarget(path);
		try {
			// removeOmpAsset checks the name; a folder that isn't there (or can't be) is already gone.
			if (target.kind === "skill" && !target.file) return await removeOmpAsset(ompDir, "skill", target.name);
			const current = (await assetFiles()).get(path)?.revision;
			// Already gone: both sides agree.
			if (current === undefined) return false;
			checkBase(current, base);
			return target.kind === "skill" ? await removeSkillFile(ompDir, target.name, target.file) : await removeOmpAsset(ompDir, "agent", target.name);
		} catch (err) {
			if (err instanceof OmpAssetError) throw invalid([{ message: err.message }]);
			throw err;
		}
	}

	async function write(req: Request, url: URL): Promise<Response> {
		const path = url.searchParams.get("path") ?? "";
		const base = url.searchParams.get("base") ?? "";
		const admin = actingAdmin(req);
		const bytes = req.method === "PUT" ? new Uint8Array(await req.arrayBuffer()) : undefined;
		const run = async (): Promise<{ action: string; result: WorkspaceSaveResult } | undefined> => {
			if (!bytes) {
				if (path === WORKSPACE_SETTINGS || path === WORKSPACE_OMP) throw invalid([{ message: `${path} can't be deleted.` }]);
				return (await deleteAsset(path, base)) ? { action: "delete", result: { ok: true, revision: "", rewritten: false } } : undefined;
			}
			const action = base ? "update" : "create";
			if (path === WORKSPACE_SETTINGS) return { action, result: await putSettings(bytes, base) };
			if (path === WORKSPACE_OMP) return { action, result: putOmp(bytes, base) };
			return { action, result: await putAsset(path, bytes, base) };
		};
		const done = writes.then(run);
		writes = done.catch(() => {});
		try {
			const applied = await done;
			// WEB-29: logged like a page save, with the file and the admin.
			if (applied) log("info", "workspace change applied", { file: path, admin, action: applied.action });
			return Response.json(applied?.result ?? ({ ok: true, revision: "", rewritten: false } satisfies WorkspaceSaveResult));
		} catch (err) {
			if (!(err instanceof WorkspaceRefusal)) throw err;
			const { body } = err;
			if (body.reason === "invalid") log("warn", "workspace change rejected", { file: path, admin, problems: body.problems.map(p => p.message) });
			else log("info", `workspace change refused: ${body.reason}`, { file: path, admin, ...(body.reason === "conflict" ? { revision: body.revision } : {}) });
			return Response.json(body, { status: err.status });
		}
	}

	return {
		"/workspace": {
			methods: ["GET"],
			async handle(req) {
				const body = await manifest();
				const headers = { ETag: `"${body.etag}"` };
				const given = req.headers.get("if-none-match")?.replace(/^W\//, "").replaceAll('"', "");
				return given === body.etag ? new Response(null, { status: 304, headers }) : Response.json(body, { headers });
			},
		},
		"/workspace/file": {
			methods: ["GET", "PUT", "DELETE"],
			async handle(req, url) {
				if (req.method !== "GET") return write(req, url);
				const path = url.searchParams.get("path") ?? "";
				let content: string | Uint8Array<ArrayBuffer> | undefined;
				try {
					content = await read(path);
				} catch (err) {
					if (err instanceof WorkspaceRefusal) return Response.json(err.body, { status: err.status });
					throw err;
				}
				if (content === undefined) return fail(404, `${path} does not exist.`);
				return new Response(content, { headers: { "Content-Type": "application/octet-stream", "X-Revision": revisionOf(content) } });
			},
		},
		"/workspace/schemas": { methods: ["GET"], handle: () => Response.json(workspaceSchemas()) },
	};
}
