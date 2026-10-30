import type { PageRoutes } from "./http";
import { logsPages } from "./logsPage";
import { modelsPages } from "./modelsPage";
import { ompPages } from "./ompPage";
import { reposPages } from "./reposPage";
import { skillsPages } from "./skillsPage";

/** The feature pages (§9.3) the web server mounts next to the built-in ones; the end-to-end tests mount the same set. */
export const FEATURE_PAGES: PageRoutes = { ...logsPages, ...reposPages, ...modelsPages, ...ompPages, ...skillsPages };
