import { createOmpUpdater, type OmpUpdater } from "../../src/orchestrator/omp/updates";
import type { Db } from "../../src/orchestrator/store/db";
import { APP_ROOT } from "../../src/shared/version";

/** The app identity test workers announce (`test/fixtures/worker-process.ts`). */
export const TEST_IDENTITY = { version: "0.0.0-test", hash: "test" };

/**
 * A real omp updater outside the image (no runtime dir, so installs are refused, UPD-05), for stacks that mount every
 * admin feature as `main.ts` does. It never talks to npm unless `check()` is called.
 */
export function outsideImageUpdater(db: Pick<Db, "kvGet" | "kvSet" | "runsInState">): OmpUpdater {
	return createOmpUpdater({ db, identity: TEST_IDENTITY, imageOmpVersion: "18.12.1", imageAppDir: APP_ROOT });
}
