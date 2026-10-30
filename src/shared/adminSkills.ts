/**
 * Skills and task agents over the admin API (AGT-24 to AGT-26, `/admin/skills`). The files live in the orchestrator
 * (`<state>/omp`); web only forwards uploads and removals.
 */

export type SkillAssetKind = "skill" | "agent";

export interface SkillAssetView {
	name: string;
	description?: string;
	/** Why omp would skip or misread this entry (AGT-25: broken entries are listed with the reason). */
	problem?: string;
}

/** GET /internal/admin/skills */
export interface SkillsListing {
	/** The orchestrator's omp directory holding `skills/` and `agents/`. */
	dir: string;
	skills: SkillAssetView[];
	agents: SkillAssetView[];
}

/**
 * POST /internal/admin/skills/upload?kind=<skill|agent>&file=<file name> with the file's bytes as the body: an agent
 * `.md`, a skill's `SKILL.md`, or a `.zip` of a skill folder. 400 `{error}` for anything AGT-25 refuses.
 */
export interface SkillUploadResponse {
	kind: SkillAssetKind;
	/** The frontmatter name, which decided where the file was stored. */
	name: string;
	/** An entry with that name existed and was replaced. */
	replaced: boolean;
}

/** POST /internal/admin/skills/remove; 404 `{error}` when there is no such entry. Answers `{ ok: true }`. */
export interface SkillRemoveRequest {
	kind: SkillAssetKind;
	name: string;
}

/** Largest file the upload accepts: a skill zip may be at most 5 MiB unpacked, plus some room for zip headers. */
export const MAX_SKILL_UPLOAD_BYTES = 6 * 1024 ** 2;
