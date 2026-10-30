import { errorMessage, log } from "../../shared/log";
import { RunDetached, type RunHandle, RunLost } from "../dispatch/dispatcher";
import { type JobRow, parseJson } from "../store/db";
import type { EngineDeps, Scheduler } from "./deps";
import { applyEvent, handleJobFailure, JobCancelled, type JobInput, runJob, terminalCleanup } from "./jobs";

/**
 * The job scheduler (JOB-01 to JOB-09), ported from DevForge `src/engine/scheduler.ts`. Differences: runs belong to the
 * dispatcher and outlive the engine, so stopping the engine detaches (jobs stay `running`, nothing is aborted or requeued)
 * and starting it re-executes `running` jobs, which re-attach to their runs (JOB-08).
 */

interface Running {
	issueId: number;
	/** Set once the run registered (AGT-07). */
	handle?: RunHandle;
	/** A cancel that arrived before the run registered; applied at registration (AGT-07). */
	cancelPending: boolean;
	done: Promise<void>;
}

export function createScheduler(deps: EngineDeps): Scheduler {
	const { db, config } = deps;
	/** jobId → job executing in this engine instance. */
	const running = new Map<string, Running>();
	/** Aborted by `detach()`; every job's signal also follows the engine's (`deps.signal`). */
	const detaching = new AbortController();
	const jobSignal = AbortSignal.any([deps.signal, detaching.signal]);

	function entryFor(issueId: number): Running | undefined {
		for (const entry of running.values()) if (entry.issueId === issueId) return entry;
		return undefined;
	}

	/** RUN-04: a lost job's first loss requeues it with `resume: true`; the second fails it. */
	function onLost(job: JobRow, err: RunLost): "requeued" | "failed" {
		const input = parseJson<JobInput>(job.input) ?? {};
		if ((input.lost ?? 0) >= 1) return "failed";
		db.requeueJob(job.id, { ...input, resume: true, lost: (input.lost ?? 0) + 1 });
		log("warn", "job run lost; requeued for resume", { job: job.id, kind: job.kind, error: err.message });
		return "requeued";
	}

	async function execute(job: JobRow, entry: Running): Promise<void> {
		try {
			const { result } = await runJob(deps, job, jobSignal, {
				onRegister: handle => {
					entry.handle = handle;
					if (entry.cancelPending) void handle.abort("user").catch(err => log("warn", "deferred abort failed", { job: job.id, error: errorMessage(err) }));
				},
			});
			db.finishJob(job.id, { status: "succeeded", result });
			log("info", "job succeeded", { job: job.id, kind: job.kind });
		} catch (err) {
			if (err instanceof RunDetached) {
				// The run keeps going; the next engine re-executes this job and re-attaches (JOB-08).
				log("info", "job detached", { job: job.id, kind: job.kind });
				return;
			}
			if (err instanceof JobCancelled) {
				db.finishJob(job.id, { status: "cancelled", error: err.message });
				log("info", "job cancelled", { job: job.id, kind: job.kind, reason: err.message });
				return;
			}
			if (err instanceof RunLost && onLost(job, err) === "requeued") return;
			const error = errorMessage(err);
			db.finishJob(job.id, { status: "failed", error });
			log("error", "job failed", { job: job.id, kind: job.kind, error });
			await handleJobFailure(deps, job, error);
		}
	}

	function launch(job: JobRow): void {
		const entry: Running = { issueId: job.issue_id, cancelPending: false, done: Promise.resolve() };
		running.set(job.id, entry);
		entry.done = execute(job, entry)
			.catch(err => log("error", "job execution failed", { job: job.id, error: errorMessage(err) }))
			.finally(() => {
				running.delete(job.id);
				tick();
			});
	}

	function tick(): void {
		while (!jobSignal.aborted && running.size < config.limits.maxConcurrentJobs) {
			const job = db.claimNextJob();
			if (!job) return;
			launch(job);
		}
	}

	return {
		tick,
		enqueue(issueId, kind, input = {}) {
			const job = db.insertJob(issueId, kind, input);
			log("info", "job queued", { job: job.id, kind, issue_id: issueId });
			tick();
			return job;
		},
		isBusy: issueId => db.activeJob(issueId) !== null,
		async cancelIssue(issueId, reason) {
			let issue = db.getIssue(issueId);
			if (!issue) return;
			db.cancelQueuedJobs(issueId);
			const entry = entryFor(issueId);
			if (entry?.handle) await entry.handle.abort("user").catch(err => log("warn", "abort failed", { issue_id: issueId, error: errorMessage(err) }));
			else if (entry) entry.cancelPending = true;
			if (issue.state === "done" || issue.state === "cancelled") return;
			issue = await applyEvent(deps, issue, "cancelled");
			await terminalCleanup(deps, issue, `⏹️ **Cancelled** — ${reason}. Archiving this thread.`);
		},
		async steer(issueId, text, from, opts) {
			const entry = entryFor(issueId);
			if (!entry) return "none";
			if (!entry.handle) return "not-ready";
			return entry.handle.steer(text, from, opts);
		},
		recover() {
			for (const job of db.runningJobs()) {
				if (running.has(job.id)) continue;
				log("info", "job re-executed after start", { job: job.id, kind: job.kind });
				launch(job);
			}
			tick();
		},
		async detach() {
			detaching.abort();
			await Promise.allSettled([...running.values()].map(entry => entry.done));
		},
	};
}
