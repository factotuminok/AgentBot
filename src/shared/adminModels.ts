/**
 * Admin API for model sign-ins (SEC-12, SEC-13; architecture CRED-01 to CRED-05), under `/internal/admin`. Sign-ins run
 * in the orchestrator against omp's store; the web page starts them, polls their state and posts the admin's input.
 *
 * - `GET /models` → {@link ModelsView}
 * - `POST /models/logins` {@link LoginStartRequest} → {@link LoginState} (400: unknown provider)
 * - `GET /models/logins/<id>` → {@link LoginState} (404: unknown or expired sign-in)
 * - `POST /models/logins/<id>/input` {@link LoginInputRequest} → {@link LoginState} (400: nothing waiting, or blank)
 * - `POST /models/logins/<id>/cancel` → {@link LoginState}
 * - `POST /models/signout` {@link SignOutRequest} → {@link SignOutResponse}
 */

/** An omp sign-in provider. */
export interface LoginProvider {
	id: string;
	name: string;
	/** Provider id the credential is stored under (e.g. `openai-codex-device` → `openai-codex`). */
	storedAs: string;
	/** One of the SEC-12 featured providers, listed first in their fixed order. */
	featured: boolean;
}

export interface StoredAccount {
	credentialId: number;
	provider: string;
	type: "oauth" | "api_key";
	email?: string;
	accountId?: string;
	orgName?: string;
	/** Access token expiry (the orchestrator refreshes it). */
	expiresAt?: string;
	/** Absolute deadline after which a new sign-in is required (Anthropic subscription grants). */
	reloginBy?: string;
	authorizedAt?: string;
	disabledCause?: string;
}

export interface ModelInfo {
	provider: string;
	/** `provider/id`, as used in the settings' model fields. */
	id: string;
	name: string;
}

export interface ModelsView {
	/** Featured providers first (SEC-12), the rest by name. */
	providers: LoginProvider[];
	accounts: StoredAccount[];
	/** Models usable with the current sign-ins. */
	models: ModelInfo[];
}

export type LoginStatus = "starting" | "waiting" | "needs_input" | "done" | "failed" | "cancelled";

/** Statuses after which a sign-in no longer changes. */
export const FINISHED_LOGIN: Record<LoginStatus, boolean> = {
	starting: false,
	waiting: false,
	needs_input: false,
	done: true,
	failed: true,
	cancelled: true,
};

/** One sign-in in progress, as rendered by the page. */
export interface LoginState {
	id: string;
	provider: string;
	providerName: string;
	status: LoginStatus;
	/** Where the admin signs in (browser OAuth or device-code page). */
	url?: string;
	/** Device flows: the code to enter (or other provider instructions). */
	instructions?: string;
	progress: string[];
	/** Set while `status` is `needs_input`. */
	input?: { kind: "redirect" | "prompt"; message: string; placeholder?: string };
	error?: string;
	account?: { email?: string; orgName?: string };
	startedAt: string;
}

export interface LoginStartRequest {
	provider: string;
}

export interface LoginInputRequest {
	text: string;
}

export interface SignOutRequest {
	provider: string;
}

export interface SignOutResponse {
	removed: boolean;
}
