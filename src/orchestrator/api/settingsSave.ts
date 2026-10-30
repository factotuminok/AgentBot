import type { SettingsSaveResponse } from "../../shared/adminApi";
import { ConfigError, parseSettings, type Settings, type SettingsIssue } from "../../shared/config";
import type { Controller } from "../engine/controller";
import { githubKeyProblem } from "../github/app";
import type { Vault } from "../store/vault";
import type { ChannelCheck } from "./channels";
import { healthLimits } from "./health";

/**
 * The Settings page save (ENG-02), shared by `PUT /settings` and the config workspace's settings.json (WEB-26), so both
 * apply exactly the same rules: §13, GH-02 and WEB-24.
 */

export interface SettingsSaveDeps {
	vault: Pick<Vault, "writeSettings">;
	controller: Pick<Controller, "apply" | "status">;
	workerCapacity: number;
	/** WEB-24; omitted, channels are not checked. */
	checkChannels?: (settings: Settings) => Promise<ChannelCheck>;
}

/** A refused save: `message` is what the Settings page shows, `issues` locate every error in the settings. */
export class SettingsRejected extends Error {
	override name = "SettingsRejected";
	constructor(
		message: string,
		readonly issues: SettingsIssue[],
	) {
		super(message);
	}
}

/**
 * Validates `raw` (secrets already resolved), stores it and restarts the engine; throws `SettingsRejected`. `beforeWrite`
 * runs synchronously right before the vault write, after the channel check's wait, so it can refuse a save that a
 * concurrent one overtook.
 */
export async function storeSettings(deps: SettingsSaveDeps, raw: { config: unknown; secrets: unknown }, beforeWrite?: () => void): Promise<SettingsSaveResponse> {
	let settings: Settings;
	try {
		settings = parseSettings(raw);
	} catch (err) {
		if (err instanceof ConfigError) throw new SettingsRejected(err.message, err.issues);
		throw err;
	}
	const keyProblem = githubKeyProblem(settings.secrets.githubAppPrivateKey);
	if (keyProblem) {
		const message = `GitHub App private key: ${keyProblem}.`;
		throw new SettingsRejected(message, [{ path: ["secrets", "githubAppPrivateKey"], message }]);
	}
	const channels = (await deps.checkChannels?.(settings)) ?? { errors: [], warnings: [] };
	if (channels.errors.length) throw new SettingsRejected(channels.errors.map(e => e.message).join(" "), channels.errors);
	beforeWrite?.();
	deps.vault.writeSettings(settings);
	await deps.controller.apply();
	const { phase, error } = deps.controller.status();
	return { phase, error, warnings: [...channels.warnings, ...healthLimits(settings.config, deps.workerCapacity).warnings] };
}
