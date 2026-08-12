export interface BrokenRef {
  method: string;
  resolvedPath: string;
  templateName: string;   // the string passed to res.render()
  file: string;
  line: number;
  /** Absolute path of the Express project root this broken ref belongs to. */
  projectRoot?: string;
}

export interface ExpressApp {
  routes: Route[];
  middleware: MiddlewareEntry[];
  templates: Template[];
  orphanedTemplates: OrphanedTemplate[];
  duplicateRoutes: Route[][];
  brokenRefs: BrokenRef[];
  viewsDir: string;
  viewEngine: string;   // e.g. 'ejs', 'pug', 'hbs', 'njk', '' if unknown
  expressVersion: string;  // e.g. '5.1.0', '' if not found
  /**
   * True when async route errors are caught automatically at the framework level —
   * i.e. Express 5+, or the express-async-errors / express-async-handler package is
   * present. When true, the "async without try/catch" warnings are suppressed.
   */
  asyncErrorsSafe: boolean;
}

export interface OrphanedTemplate {
  name: string;  // relative path without extension
  file: string;  // absolute path to template file
  /** Absolute path of the Express project root this template belongs to. */
  projectRoot?: string;
}

export interface Route {
  method: string;
  path: string;
  resolvedPath: string;
  file: string;
  line: number;
  isAsync: boolean;
  hasTryCatch: boolean;   // false = async handler with no try/catch (potential crash)
  /**
   * True when the registered handler was a wrapper call around a single
   * function — `asyncHandler(async (req, res) => …)` — and the flags above
   * describe the function inside it rather than the call.
   *
   * Such routes never raise the async-without-try/catch warning: a wrapper
   * taking one handler exists to do something with what that handler throws,
   * and its body isn't visible from the call site to prove otherwise.
   */
  wrappedHandler?: boolean;
  params: string[];
  responseType: 'render' | 'json' | 'send' | 'redirect' | 'download' | 'unknown';
  templateName?: string;
  /** Additional render templates found in the same handler (fallback/error paths). */
  extraTemplateRefs: string[];
  middleware: MiddlewareEntry[];
  /** Absolute path of the Express project root this route belongs to (set by analyzeWorkspace). */
  projectRoot?: string;
  /**
   * True when async errors are automatically caught for this route's project
   * (Express 5+, or express-async-errors / express-async-handler present).
   * Checked per-route so multi-project workspaces don't produce false positives.
   */
  asyncErrorsSafe?: boolean;
}

export interface MiddlewareEntry {
  name?: string;
  file: string;
  line: number;
  scope: 'global' | 'router' | 'route';
  /**
   * When true this entry is a terminal catch-all handler (404 handler, error handler)
   * rather than a pipeline middleware layer. Classified separately in the tree under
   * "Catch-all Handlers".
   */
  isCatchAll?: boolean;
  /** Absolute path of the Express project root this middleware belongs to. */
  projectRoot?: string;
}

export interface Template {
  name: string;
  file: string;
  usedByRoutes: RouteRef[];
  /** Absolute path of the Express project root this template belongs to. */
  projectRoot?: string;
}

export interface RouteRef {
  label: string; // e.g. "GET /admin/archives"
  file: string;
  line: number;
}
