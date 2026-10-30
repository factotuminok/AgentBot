/**
 * Routes a typed message in a thread to the agent question waiting there (an ask dialog, input or editor prompt),
 * so the reply answers the question instead of reaching the agent a second time as steering.
 * Each thread runs at most one agent session, so there is at most one waiting question per thread.
 */
export interface ThreadReplies {
	/**
	 * Resolves with the next reply delivered to `threadId`, or undefined after `timeoutMs`.
	 * Rejects with an AbortError when `signal` aborts. A newer wait on the same thread replaces an older one.
	 */
	next(threadId: string, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined>;
	/** Hands `text` to the question waiting in `threadId`; false when nothing is waiting there. */
	deliver(threadId: string, text: string): boolean;
}

export function createThreadReplies(): ThreadReplies {
	const waiting = new Map<string, (text: string | undefined) => void>();
	return {
		next(threadId, timeoutMs, signal) {
			const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
			if (signal?.aborted) {
				reject(new DOMException("aborted", "AbortError"));
				return promise;
			}
			// A replaced wait resolves as "no answer" rather than hanging.
			waiting.get(threadId)?.(undefined);
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (waiting.get(threadId) === finish) waiting.delete(threadId);
			};
			const finish = (text: string | undefined) => {
				cleanup();
				resolve(text);
			};
			const onAbort = () => {
				cleanup();
				reject(new DOMException("aborted", "AbortError"));
			};
			const timer = setTimeout(() => finish(undefined), Math.max(timeoutMs, 1));
			signal?.addEventListener("abort", onAbort, { once: true });
			waiting.set(threadId, finish);
			return promise;
		},
		deliver(threadId, text) {
			const finish = waiting.get(threadId);
			if (!finish) return false;
			finish(text);
			return true;
		},
	};
}
