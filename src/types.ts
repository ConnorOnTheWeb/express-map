export interface BrokenRef {
  method: string;
  resolvedPath: string;
  templateName: string;   // the string passed to res.render()
  file: string;
  line: number;
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
}

export interface Route {
  method: string;
  path: string;
  resolvedPath: string;
  file: string;
  line: number;
  isAsync: boolean;
  hasTryCatch: boolean;   // false = async handler with no try/catch (potential crash)
  params: string[];
  responseType: 'render' | 'json' | 'send' | 'redirect' | 'download' | 'unknown';
  templateName?: string;
  /** Additional render templates found in the same handler (fallback/error paths). */
  extraTemplateRefs: string[];
  middleware: MiddlewareEntry[];
  /** Absolute path of the Express project root this route belongs to (set by analyzeWorkspace). */
  projectRoot?: string;
}

export interface MiddlewareEntry {
  name?: string;
  file: string;
  line: number;
  scope: 'global' | 'router' | 'route';
}

export interface Template {
  name: string;
  file: string;
  usedByRoutes: RouteRef[];
}

export interface RouteRef {
  label: string; // e.g. "GET /admin/archives"
  file: string;
  line: number;
}
