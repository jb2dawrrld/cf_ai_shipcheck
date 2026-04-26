import { DurableObject } from "cloudflare:workers";
import type { ChatMessage, ShipReadinessReport, ReviewSessionState } from "../types";

const STORAGE_KEY = "review_session";

/**
 * ReviewAgent — one Durable Object instance per repository (see Worker routing:
 * `REVIEW_AGENT.getByName(sessionId)` where `sessionId` is derived from `repoUrl`).
 *
 * Why Durable Objects here:
 * - **Single-threaded consistency**: all reads/writes for that repo’s review state
 *   go through one coordinator; no lost updates from concurrent POSTs.
 * - **Durable storage**: `this.ctx.storage` survives hibernation and process restarts,
 *   unlike plain class fields, so `repoUrl`, `prNumber`, and `status` are reliable.
 * - **Colocation**: the object runs close to the storage for that id; good baseline
 *   for later adding AI steps, webhooks, or alarms on this namespace.
 *
 * RPC methods on this class are invoked from the Worker via the stub
 * (`stub.startReview(...)`, `stub.getReviewState()`), which routes to this instance.
 */
export class ReviewAgent extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/** Load persisted session from DO storage (empty if never started). */
	private async load(): Promise<ReviewSessionState | null> {
		const state = (await this.ctx.storage.get<ReviewSessionState>(STORAGE_KEY)) ?? null;
		if (!state) {
			return null;
		}
		return {
			...state,
			chat: state.chat ?? [],
		};
	}

	private async save(state: ReviewSessionState): Promise<void> {
		await this.ctx.storage.put(STORAGE_KEY, state);
	}

	/**
	 * Initialize or refresh review metadata for this repo-scoped session.
	 * New starts reset status to `idle`.
	 */
	async startReview(input: {
		sessionId: string;
		repoUrl: string;
		prNumber?: number;
	}): Promise<ReviewSessionState> {
		const now = Date.now();
		const state: ReviewSessionState = {
			sessionId: input.sessionId,
			repoUrl: input.repoUrl,
			prNumber: input.prNumber,
			status: "idle",
			chat: [],
			updatedAt: now,
		};
		await this.save(state);
		return state;
	}

	/** Read-only snapshot for GET /api/reviews/:id */
	async getReviewState(): Promise<ReviewSessionState | null> {
		return this.load();
	}

	/** Mark an existing session as actively analyzing files. */
	async markAnalyzing(): Promise<ReviewSessionState | null> {
		const current = await this.load();
		if (!current) {
			return null;
		}
		const next: ReviewSessionState = {
			...current,
			status: "analyzing",
			error: undefined,
			updatedAt: Date.now(),
		};
		await this.save(next);
		return next;
	}

	/** Persist either a successful report or an error and finalize as done. */
	async completeReview(result: {
		report?: ShipReadinessReport;
		error?: string;
	}): Promise<ReviewSessionState | null> {
		const current = await this.load();
		if (!current) {
			return null;
		}
		const next: ReviewSessionState = {
			...current,
			status: "done",
			report: result.report,
			error: result.error,
			updatedAt: Date.now(),
		};
		await this.save(next);
		return next;
	}

	async appendChatMessage(message: ChatMessage): Promise<ReviewSessionState | null> {
		const current = await this.load();
		if (!current) {
			return null;
		}
		const next: ReviewSessionState = {
			...current,
			chat: [...(current.chat ?? []), message],
			updatedAt: Date.now(),
		};
		await this.save(next);
		return next;
	}
}
