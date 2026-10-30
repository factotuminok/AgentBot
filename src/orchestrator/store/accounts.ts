import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { getOAuthCredentialProvider, getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { ANTHROPIC_OAUTH_GRANT_TTL_MS } from "@oh-my-pi/pi-ai/registry/oauth/anthropic-constants";
import type { OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { LoginProvider, LoginState, ModelInfo, ModelsView, StoredAccount } from "../../shared/adminModels";
import { errorMessage, log } from "../../shared/log";
import { type Signins, signinsDir } from "./signins";

/**
 * Model sign-in flows (SEC-12, SEC-13): omp's own OAuth sign-in, run in the orchestrator against the sign-in store
 * (CRED-01). The admin drives a flow from `/admin/models` through the admin API: browser flows take the pasted redirect
 * URL or code, device flows show the code and finish by omp's own polling. New sign-ins land in the store that
 * `snapshotForRun` reads, so the next run uses them without a restart.
 */

/** Shown first on the page, in this order; every other omp sign-in provider follows by name (SEC-12). */
export const FEATURED_PROVIDERS: readonly string[] = ["anthropic", "xai-oauth", "google-gemini-cli", "google-antigravity", "openai-codex", "openai-codex-device", "github-copilot"];
/** A sign-in left unattended this long is aborted (the provider's own codes expire sooner). */
export const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** Finished sign-ins stay readable briefly so the page can show the result. */
const FINISHED_RETENTION_MS = 10 * 60_000;

/** omp's OAuth helpers behind an interface, so tests drive flows with a fake and never reach a real provider. */
export interface SigninBackend {
	/** Sign-in providers that can be used here, in any order. */
	providers(): { id: string; name: string; storedAs: string }[];
	/** Runs one provider's sign-in and stores the credential; resolves with the signed-in identity. */
	login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<{ email?: string; orgName?: string } | undefined>;
	/** Models usable with the stored sign-ins. */
	models(): ModelInfo[];
	/** The stored sign-ins changed (sign-in or sign-out). */
	changed(): void;
}

/** The real backend: omp's OAuth registry and `authStorage.oauth.login`, and a `ModelRegistry` over the store. */
export function ompSigninBackend(signins: Signins, stateDir: string): SigninBackend {
	const { authStorage } = signins;
	const registry = new ModelRegistry(authStorage, join(signinsDir(stateDir), "models.yml"));
	const refresh = (strategy?: "offline") => registry.refresh(strategy).catch(err => log("warn", "model registry refresh failed", { error: errorMessage(err) }));
	void refresh("offline");
	return {
		providers: () =>
			getOAuthProviders()
				.filter(p => p.available)
				.map(p => ({ id: p.id, name: p.name, storedAs: getOAuthCredentialProvider(p.id) })),
		login: (providerId, callbacks) => authStorage.oauth.login(providerId, callbacks),
		models: () => registry.getAvailable().map(model => ({ provider: model.provider, id: `${model.provider}/${model.id}`, name: model.name })),
		changed: () => void refresh(),
	};
}

export interface AccountsOptions {
	signins: Signins;
	backend: SigninBackend;
	/** Schedules the unattended-sign-in abort; returns a cancel function. Default `setTimeout` (tests fire it by hand). */
	schedule?: (fn: () => void, ms: number) => () => void;
}

export interface Accounts {
	view(): ModelsView;
	startLogin(providerId: string): LoginState;
	login(id: string): LoginState | undefined;
	/** Answers a pending prompt or pasted redirect URL/code. False when nothing is waiting or `text` is blank. */
	submitInput(id: string, text: string): boolean;
	cancelLogin(id: string): void;
	/** CRED-05: removes every sign-in of `provider`; false when there was none. */
	signOut(provider: string): Promise<boolean>;
}

interface LoginRecord {
	state: LoginState;
	abort: AbortController;
	pendingInput?: (text: string) => void;
	cancelTimeout: () => void;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
	const timer = setTimeout(fn, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
}

const TIMED_OUT = "Sign-in timed out: it was left unattended for 15 minutes.";

export function createAccounts(opts: AccountsOptions): Accounts {
	const { signins, backend } = opts;
	const schedule = opts.schedule ?? defaultSchedule;
	const logins = new Map<string, LoginRecord>();

	function providers(): LoginProvider[] {
		const rank = (id: string) => (FEATURED_PROVIDERS.includes(id) ? FEATURED_PROVIDERS.indexOf(id) : FEATURED_PROVIDERS.length);
		return backend
			.providers()
			.map(p => ({ ...p, featured: FEATURED_PROVIDERS.includes(p.id) }))
			.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
	}

	function accounts(): StoredAccount[] {
		return signins.authStorage.credentials.list().map(({ id, provider, credential, disabledCause }) => {
			const account: StoredAccount = { credentialId: id, provider, type: credential.type };
			if (credential.type === "oauth") {
				if (credential.email) account.email = credential.email;
				if (credential.accountId) account.accountId = credential.accountId;
				if (credential.orgName) account.orgName = credential.orgName;
				if (typeof credential.expires === "number") account.expiresAt = new Date(credential.expires).toISOString();
				if (typeof credential.authorizedAt === "number") {
					account.authorizedAt = new Date(credential.authorizedAt).toISOString();
					if (provider === "anthropic") account.reloginBy = new Date(credential.authorizedAt + ANTHROPIC_OAUTH_GRANT_TTL_MS).toISOString();
				}
			}
			if (disabledCause) account.disabledCause = disabledCause;
			return account;
		});
	}

	function finish(record: LoginRecord, patch: Partial<LoginState>): void {
		record.cancelTimeout();
		record.pendingInput = undefined;
		Object.assign(record.state, { input: undefined, ...patch });
		const timer = setTimeout(() => logins.delete(record.state.id), FINISHED_RETENTION_MS);
		timer.unref?.();
	}

	/** Parks the flow until the admin submits text on the page (or the sign-in is aborted). */
	function awaitInput(record: LoginRecord, input: NonNullable<LoginState["input"]>, signal?: AbortSignal): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		Object.assign(record.state, { status: "needs_input", input });
		record.pendingInput = text => {
			record.pendingInput = undefined;
			Object.assign(record.state, { status: "waiting", input: undefined });
			resolve(text);
		};
		const onAbort = () => reject(new Error("Sign-in cancelled"));
		signal?.addEventListener("abort", onAbort, { once: true });
		record.abort.signal.addEventListener("abort", onAbort, { once: true });
		return promise;
	}

	return {
		view() {
			return {
				providers: providers(),
				accounts: accounts(),
				models: backend.models().sort((a, b) => a.id.localeCompare(b.id)),
			};
		},

		startLogin(providerId) {
			const provider = backend.providers().find(p => p.id === providerId);
			if (!provider) throw new Error(`Unknown sign-in provider "${providerId}"`);
			const id = randomBytes(12).toString("base64url");
			const abort = new AbortController();
			const record: LoginRecord = {
				state: { id, provider: provider.id, providerName: provider.name, status: "starting", progress: [], startedAt: new Date().toISOString() },
				abort,
				cancelTimeout: schedule(() => abort.abort(new Error(TIMED_OUT)), LOGIN_TIMEOUT_MS),
			};
			logins.set(id, record);
			log("info", "model sign-in started", { provider: provider.id });

			void backend
				.login(provider.id, {
					signal: abort.signal,
					onAuth: info => Object.assign(record.state, { status: record.state.status === "needs_input" ? "needs_input" : "waiting", url: info.url, instructions: info.instructions }),
					onProgress: message => {
						record.state.progress.push(message);
						if (record.state.status === "starting") record.state.status = "waiting";
					},
					// Browser flows redirect to a loopback port in the orchestrator; the admin's browser can't reach it, so the
					// final redirect URL (or code) is pasted back instead.
					onManualCodeInput: signal =>
						awaitInput(record, { kind: "redirect", message: "After signing in, paste the full URL from the browser's address bar (or the code shown):" }, signal),
					onPrompt: prompt => awaitInput(record, { kind: "prompt", message: prompt.message, placeholder: prompt.placeholder }),
				})
				.then(identity => {
					if (abort.signal.aborted) throw abort.signal.reason;
					finish(record, { status: "done", account: identity ? { email: identity.email, orgName: identity.orgName } : undefined });
					log("info", "model sign-in completed", { provider: provider.id, email: identity?.email });
					backend.changed();
				})
				.catch(err => {
					const reason = abort.signal.aborted ? errorMessage(abort.signal.reason) : undefined;
					const cancelled = reason !== undefined && reason !== TIMED_OUT;
					finish(record, cancelled ? { status: "cancelled" } : { status: "failed", error: reason ?? errorMessage(err) });
					if (!cancelled) log("warn", "model sign-in failed", { provider: provider.id, error: record.state.error });
				});
			return record.state;
		},

		login: id => logins.get(id)?.state,

		submitInput(id, text) {
			const record = logins.get(id);
			if (!record?.pendingInput || !text.trim()) return false;
			record.pendingInput(text.trim());
			return true;
		},

		cancelLogin(id) {
			const record = logins.get(id);
			if (record && (record.state.status === "starting" || record.state.status === "waiting" || record.state.status === "needs_input")) {
				record.abort.abort(new Error("Sign-in cancelled"));
			}
		},

		async signOut(provider) {
			const removed = await signins.signOut(provider);
			if (removed) backend.changed();
			return removed;
		},
	};
}
