import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	WorkspaceConflict,
	WorkspaceLocked,
	WorkspaceManifest,
	WorkspaceRejection,
	WorkspaceSaveResult,
} from "../../shared/adminWorkspace";
import { AdminApiError, type AdminClient } from "../adminClient";

/** The orchestrator's config workspace endpoints (`src/shared/adminWorkspace.ts`) over the admin client. */

export type WorkspaceOutcome = WorkspaceSaveResult | WorkspaceRejection | WorkspaceConflict | WorkspaceLocked;

export interface RemoteFile {
	bytes: Uint8Array<ArrayBuffer>;
	revision: string;
	/** sha256 of `bytes`; equals `revision` by the contract, kept apart so local bookkeeping never depends on it. */
	hash: string;
}

const manifestSchema: z.ZodType<WorkspaceManifest> = z.object({
	etag: z.string(),
	locked: z.boolean(),
	files: z.array(z.object({ path: z.string(), revision: z.string(), size: z.number() })),
});

const outcomeSchema: z.ZodType<WorkspaceOutcome> = z.union([
	z.object({
		ok: z.literal(true),
		revision: z.string(),
		rewritten: z.boolean(),
		phase: z.string().optional(),
		error: z.string().optional(),
		warnings: z.array(z.string()).optional(),
	}),
	z.object({
		ok: z.literal(false),
		reason: z.literal("invalid"),
		problems: z.array(z.object({ message: z.string(), jsonPath: z.array(z.union([z.string(), z.number()])).optional(), line: z.number().optional() })),
	}),
	z.object({ ok: z.literal(false), reason: z.literal("conflict"), revision: z.string() }),
	z.object({ ok: z.literal(false), reason: z.literal("locked"), message: z.string() }),
]);

/** The `{error}` text of an orchestrator error body, else `HTTP <status>`. */
function errorText(body: unknown, status: number): string {
	if (body !== null && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
	return `HTTP ${status}`;
}

async function failure(res: Response): Promise<AdminApiError> {
	return new AdminApiError(res.status, errorText(await res.json().catch(() => undefined), res.status));
}

/** `GET /workspace`; undefined while `etag` still matches (304). */
export async function fetchManifest(admin: AdminClient, etag: string | undefined, signal: AbortSignal): Promise<WorkspaceManifest | undefined> {
	const res = await admin.fetch("GET", "/workspace", { headers: etag === undefined ? {} : { "If-None-Match": etag }, signal });
	if (res.status === 304) return undefined;
	if (!res.ok) throw await failure(res);
	return manifestSchema.parse(await res.json());
}

/** `GET /workspace/file`; undefined when the orchestrator has no such file. */
export async function fetchFile(admin: AdminClient, path: string, signal: AbortSignal): Promise<RemoteFile | undefined> {
	const res = await admin.fetch("GET", `/workspace/file?${new URLSearchParams({ path })}`, { signal });
	if (res.status === 404) {
		await res.body?.cancel();
		return undefined;
	}
	if (!res.ok) throw await failure(res);
	const bytes = new Uint8Array(await res.arrayBuffer());
	const hash = createHash("sha256").update(bytes).digest("hex");
	return { bytes, revision: res.headers.get("X-Revision") ?? hash, hash };
}

/**
 * `PUT` (with `body`) or `DELETE` (without) of one workspace path, based on revision `base`. Any other 4xx answer
 * reads as a rejection carrying its error text, so the admin sees it in the Problems panel; 5xx throws like an
 * unreachable orchestrator, and the save is retried.
 */
export async function saveFile(
	admin: AdminClient,
	path: string,
	base: string,
	body: Uint8Array<ArrayBuffer> | undefined,
	username: string | undefined,
	signal: AbortSignal,
): Promise<WorkspaceOutcome> {
	const res = await admin.fetch(body ? "PUT" : "DELETE", `/workspace/file?${new URLSearchParams({ path, base })}`, {
		body,
		headers: body ? { "Content-Type": "application/octet-stream" } : {},
		admin: username,
		signal,
	});
	if (res.status >= 500) throw await failure(res);
	const answer: unknown = await res.json().catch(() => undefined);
	if (res.status === 200 || res.status === 400 || res.status === 409) {
		const parsed = outcomeSchema.safeParse(answer);
		if (parsed.success) return parsed.data;
	}
	return { ok: false, reason: "invalid", problems: [{ message: errorText(answer, res.status) }] };
}
