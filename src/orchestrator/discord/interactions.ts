import type { ComponentEvent, ModalEvent } from "./surface";

/**
 * Routes component and modal interactions to code waiting for them (agent questions, DSC-16 to DSC-18), replacing
 * discord.js collectors. The bot hands every component/modal event to `dispatch` first; unclaimed events go to its own
 * static handlers (plan buttons, retry, …). Implemented by `createInteractionRouter` in `interactionRouter.ts`.
 */
export interface InteractionRouter {
	/** Delivers the event to a matching waiter; true when one took it. */
	dispatch(event: ComponentEvent | ModalEvent): boolean;
	/** The next component interaction on `messageId` accepted by `filter` (others are left to the caller to refuse), or undefined on timeout. Rejects with an AbortError when `signal` aborts. */
	nextComponent(messageId: string, opts: { timeoutMs: number; signal?: AbortSignal; filter?(e: ComponentEvent): boolean | Promise<boolean> }): Promise<ComponentEvent | undefined>;
	/** The next submit of the modal with `customId`, or undefined on timeout. */
	nextModal(customId: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<ModalEvent | undefined>;
}
