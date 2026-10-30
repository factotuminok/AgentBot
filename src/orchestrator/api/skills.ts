import { MAX_SKILL_UPLOAD_BYTES, type SkillAssetKind, type SkillRemoveRequest, type SkillsListing, type SkillUploadResponse } from "../../shared/adminSkills";
import { errorMessage, log } from "../../shared/log";
import { listOmpAssets, OmpAssetError, removeOmpAsset, saveOmpAsset, saveSkillZip } from "../store/ompAssets";
import { actingAdmin, type AdminRoutes, fail, HttpError, jsonBody, str } from "./http";

/**
 * Skills and task agents (AGT-24 to AGT-26): list, upload and remove the files in the omp directory. Sessions started
 * afterwards pick the changes up, because the skills bundle is rebuilt from disk whenever a run is claimed.
 */

export interface SkillsRoutesOptions {
	/** `env.ompDir`. */
	ompDir: string;
}

function assetKind(value: unknown): SkillAssetKind {
	if (value === "skill" || value === "agent") return value;
	throw new HttpError(400, "Choose whether the file is a skill or an agent.");
}

export function createSkillsRoutes(opts: SkillsRoutesOptions): AdminRoutes {
	const { ompDir } = opts;

	async function upload(req: Request, url: URL): Promise<Response> {
		const kind = assetKind(url.searchParams.get("kind"));
		const fileName = url.searchParams.get("file") ?? "";
		if (Number(req.headers.get("content-length") ?? 0) > MAX_SKILL_UPLOAD_BYTES) return fail(400, `${fileName} is too large.`);
		const bytes = new Uint8Array(await req.arrayBuffer());
		if (bytes.length === 0) return fail(400, "Choose a file to upload.");
		if (bytes.length > MAX_SKILL_UPLOAD_BYTES) return fail(400, `${fileName} is too large.`);
		const isZip = fileName.toLowerCase().endsWith(".zip");
		if (isZip && kind === "agent") return fail(400, "An agent is a single .md file; only skills can be uploaded as a .zip.");
		let saved: { name: string; replaced: boolean };
		try {
			saved = isZip ? await saveSkillZip(ompDir, fileName, bytes) : await saveOmpAsset(ompDir, kind, fileName, new TextDecoder().decode(bytes));
		} catch (err) {
			if (err instanceof OmpAssetError) return fail(400, err.message);
			throw err;
		}
		log("info", "omp asset uploaded", { kind, name: saved.name, replaced: saved.replaced, zip: isZip, admin: actingAdmin(req) });
		return Response.json({ kind, ...saved } satisfies SkillUploadResponse);
	}

	async function remove(req: Request): Promise<Response> {
		const body = await jsonBody<SkillRemoveRequest>(req);
		const kind = assetKind(body.kind);
		const name = str(body.name);
		if (!(await removeOmpAsset(ompDir, kind, name))) return fail(404, `No ${kind} named "${name}".`);
		log("info", "omp asset removed", { kind, name, admin: actingAdmin(req) });
		return Response.json({ ok: true });
	}

	return {
		"/skills": {
			methods: ["GET"],
			async handle() {
				try {
					return Response.json({ dir: ompDir, ...(await listOmpAssets(ompDir)) } satisfies SkillsListing);
				} catch (err) {
					log("warn", "could not list skills and agents", { error: errorMessage(err) });
					return fail(500, `Skills and agents could not be read: ${errorMessage(err)}`);
				}
			},
		},
		"/skills/upload": { methods: ["POST"], handle: upload },
		"/skills/remove": { methods: ["POST"], handle: remove },
	};
}
