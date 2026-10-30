import { errorMessage, log } from "../../shared/log";
import { abortError } from "../../shared/ui";
import type { InteractionRouter } from "./interactions";
import type { ComponentEvent, ModalEvent } from "./surface";

interface Waiter<E> {
	done: boolean;
	filter?(event: E): boolean | Promise<boolean>;
	finish(event: E | undefined): void;
}

/** Registers a waiter under `key` until it is answered, times out or aborts. */
function wait<E>(
	table: Map<string, Waiter<E>[]>,
	key: string,
	opts: { timeoutMs: number; signal?: AbortSignal; filter?(event: E): boolean | Promise<boolean> },
): Promise<E | undefined> {
	const { promise, resolve, reject } = Promise.withResolvers<E | undefined>();
	if (opts.signal?.aborted) {
		reject(abortError());
		return promise;
	}
	const cleanup = () => {
		waiter.done = true;
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		const list = table.get(key)?.filter(w => w !== waiter);
		if (list?.length) table.set(key, list);
		else table.delete(key);
	};
	const waiter: Waiter<E> = {
		done: false,
		filter: opts.filter,
		finish(event) {
			cleanup();
			resolve(event);
		},
	};
	const onAbort = () => {
		cleanup();
		reject(abortError());
	};
	const timer = setTimeout(() => waiter.finish(undefined), Math.max(opts.timeoutMs, 1));
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	table.set(key, [...(table.get(key) ?? []), waiter]);
	return promise;
}

/**
 * Hands a claimed event to the first waiter whose filter accepts it. The filter of the code that waits refuses the
 * others itself (e.g. "Not authorized."); an accepted event that arrives after every waiter finished is told so.
 */
async function deliver<E extends ComponentEvent | ModalEvent>(waiters: Waiter<E>[], event: E): Promise<void> {
	for (const waiter of waiters) {
		if (waiter.done) continue;
		let accepted: boolean;
		try {
			accepted = waiter.filter ? await waiter.filter(event) : true;
		} catch (err) {
			log("warn", "interaction filter failed", { customId: event.customId, error: errorMessage(err) });
			accepted = false;
		}
		if (!accepted) return;
		if (!waiter.done) {
			waiter.finish(event);
			return;
		}
	}
	await event.reply({ content: "This question was already answered.", ephemeral: true }).catch(() => {});
}

export function createInteractionRouter(): InteractionRouter {
	const components = new Map<string, Waiter<ComponentEvent>[]>();
	const modals = new Map<string, Waiter<ModalEvent>[]>();
	return {
		dispatch(event) {
			if (event.type === "component") {
				const waiters = components.get(event.message.messageId);
				if (!waiters?.length) return false;
				void deliver(waiters, event);
				return true;
			}
			const waiters = modals.get(event.customId);
			if (!waiters?.length) return false;
			void deliver(waiters, event);
			return true;
		},
		nextComponent(messageId, opts) {
			return wait(components, messageId, opts);
		},
		nextModal(customId, opts) {
			return wait(modals, customId, opts);
		},
	};
}
