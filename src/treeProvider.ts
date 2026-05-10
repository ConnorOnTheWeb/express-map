import * as vscode from 'vscode';
import * as path from 'path';
import type { ExpressApp, Route, MiddlewareEntry, Template, OrphanedTemplate, RouteRef, BrokenRef } from './types';

// ─── item kinds ───────────────────────────────────────────────────────────────

type ItemKind =
  | 'group'
  | 'routePrefix'
  | 'route'
  | 'routeMiddleware'
  | 'routeTemplate'
  | 'template'
  | 'templateRoute'
  | 'orphan'
  | 'middleware'
  | 'duplicateGroup'
  | 'duplicateRoute'
  | 'brokenRef'
  | 'issueRoute'
  | 'empty';

// ─── method colours via product icon ids ──────────────────────────────────────

const METHOD_ICONS: Record<string, string> = {
  GET:     'arrow-down',
  POST:    'arrow-up',
  PUT:     'edit',
  PATCH:   'diff-modified',
  DELETE:  'trash',
  HEAD:    'eye',
  OPTIONS: 'settings',
  ALL:     'globe',
};

const SCOPE_LABELS: Record<MiddlewareEntry['scope'], string> = {
  global: 'global',
  router: 'router',
  route:  'route',
};

// ─── ExpressMapItem ───────────────────────────────────────────────────────────

export class ExpressMapItem extends vscode.TreeItem {
  readonly kind: ItemKind;

  // Navigation target — set for items that should open a file on click
  readonly targetUri?: vscode.Uri;
  readonly targetLine?: number;

  // Children data — resolved lazily in getChildren()
  readonly routeData?: Route;
  readonly routePrefixData?: Route[];
  readonly templateData?: Template;
  readonly middlewareData?: MiddlewareEntry;
  readonly duplicateGroupData?: Route[];
  readonly templateRouteLabel?: string;
  /** Parent item — stored so getParent() can walk the chain for treeView.reveal(). */
  readonly parentItem?: ExpressMapItem;

  constructor(options: {
    label: string;
    kind: ItemKind;
    collapsibleState?: vscode.TreeItemCollapsibleState;
    description?: string;
    tooltip?: string | vscode.MarkdownString;
    iconPath?: vscode.ThemeIcon;
    contextValue?: string;
    targetUri?: vscode.Uri;
    targetLine?: number;
    routeData?: Route;
    routePrefixData?: Route[];
    templateData?: Template;
    middlewareData?: MiddlewareEntry;
    duplicateGroupData?: Route[];
    templateRouteLabel?: string;
    parentItem?: ExpressMapItem;
  }) {
    super(
      options.label,
      options.collapsibleState ?? vscode.TreeItemCollapsibleState.None,
    );
    this.kind = options.kind;
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.iconPath = options.iconPath;
    this.contextValue = options.contextValue ?? options.kind;
    this.targetUri = options.targetUri;
    this.targetLine = options.targetLine;
    this.routeData = options.routeData;
    this.routePrefixData = options.routePrefixData;
    this.templateData = options.templateData;
    this.middlewareData = options.middlewareData;
    this.duplicateGroupData = options.duplicateGroupData;
    this.templateRouteLabel = options.templateRouteLabel;
    this.parentItem = options.parentItem;

    // Set command for navigable items
    if (options.targetUri !== undefined && options.targetLine !== undefined) {
      this.command = makeOpenCommand(options.targetUri, options.targetLine);
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeOpenCommand(uri: vscode.Uri, line: number): vscode.Command {
  const pos = new vscode.Position(Math.max(0, line - 1), 0);
  return {
    command: 'vscode.open',
    title: 'Open File',
    arguments: [uri, { selection: new vscode.Range(pos, pos) }],
  };
}

function methodIcon(method: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(METHOD_ICONS[method] ?? 'symbol-method');
}

function shortPath(filePath: string): string {
  // Show the last two path segments for readability
  const parts = filePath.split(path.sep);
  return parts.slice(-2).join(path.sep);
}

function routeTooltip(route: Route): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${route.method} \`${route.resolvedPath}\`**\n\n`);
  md.appendMarkdown(`- File: \`${shortPath(route.file)}\` line ${route.line}\n`);
  if (route.params.length) {
    md.appendMarkdown(`- Params: ${route.params.map(p => `\`:${p}\``).join(', ')}\n`);
  }
  md.appendMarkdown(`- Response: \`${route.responseType}\`\n`);
  if (route.templateName) {
    md.appendMarkdown(`- Template: \`${route.templateName}\`\n`);
  }
  if (route.isAsync) { md.appendMarkdown(`- $(zap) async handler\n`); }
  if (route.middleware.length) {
    md.appendMarkdown(`- Middleware: ${route.middleware.length} entr${route.middleware.length === 1 ? 'y' : 'ies'}\n`);
  }
  return md;
}

function middlewareTooltip(mw: MiddlewareEntry): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**Middleware** — scope: \`${mw.scope}\`\n\n`);
  md.appendMarkdown(`- File: \`${shortPath(mw.file)}\` line ${mw.line}\n`);
  if (mw.name) { md.appendMarkdown(`- Name: \`${mw.name}\`\n`); }
  return md;
}

// ─── factory functions for each item type ────────────────────────────────────

function makeGroup(
  label: string,
  kind: ItemKind,
  count: number,
  icon: string,
  collapsed = false,
): ExpressMapItem {
  return new ExpressMapItem({
    label,
    kind,
    collapsibleState: collapsed
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded,
    description: `${count}`,
    iconPath: new vscode.ThemeIcon(icon),
  });
}

function makeRoutePrefixItem(prefix: string, routes: Route[], parentItem?: ExpressMapItem): ExpressMapItem {
  return new ExpressMapItem({
    label: prefix,
    kind: 'routePrefix',
    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
    description: `${routes.length} routes`,
    iconPath: new vscode.ThemeIcon('list-tree'),
    routePrefixData: routes,
    parentItem,
  });
}

function makeRouteItem(route: Route, parentItem?: ExpressMapItem): ExpressMapItem {
  const hasChildren = route.middleware.length > 0 || !!route.templateName;
  return new ExpressMapItem({
    label: `${route.method}  ${route.resolvedPath}`,
    kind: 'route',
    collapsibleState: hasChildren
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
    description: shortPath(route.file),
    tooltip: routeTooltip(route),
    iconPath: methodIcon(route.method),
    contextValue: `route.${route.method.toLowerCase()}`,
    targetUri: vscode.Uri.file(route.file),
    targetLine: route.line,
    routeData: route,
    parentItem,
  });
}

function makeRouteMiddlewareItem(mw: MiddlewareEntry): ExpressMapItem {
  return new ExpressMapItem({
    label: mw.name ?? '(anonymous)',
    kind: 'routeMiddleware',
    description: `${SCOPE_LABELS[mw.scope]} · line ${mw.line}`,
    tooltip: middlewareTooltip(mw),
    iconPath: new vscode.ThemeIcon('symbol-function'),
    targetUri: vscode.Uri.file(mw.file),
    targetLine: mw.line,
  });
}

function makeRouteTemplateItem(templateName: string, fileUri?: vscode.Uri): ExpressMapItem {
  return new ExpressMapItem({
    label: templateName,
    kind: 'routeTemplate',
    description: 'template',
    tooltip: new vscode.MarkdownString(`Template rendered by this route`),
    iconPath: new vscode.ThemeIcon('file-code'),
    targetUri: fileUri,
    targetLine: fileUri ? 1 : undefined,
  });
}

function makeTemplateItem(template: Template): ExpressMapItem {
  const hasRoutes = template.usedByRoutes.length > 0;
  return new ExpressMapItem({
    label: template.name,
    kind: 'template',
    collapsibleState: hasRoutes
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
    description: `${template.usedByRoutes.length} route${template.usedByRoutes.length !== 1 ? 's' : ''}`,
    tooltip: new vscode.MarkdownString(`**${template.name}** template\n\nUsed by ${template.usedByRoutes.length} route(s)`),
    iconPath: new vscode.ThemeIcon('file-code'),
    targetUri: vscode.Uri.file(template.file),
    targetLine: 1,
    templateData: template,
  });
}

function makeTemplateRouteItem(ref: RouteRef): ExpressMapItem {
  return new ExpressMapItem({
    label: ref.label,
    kind: 'templateRoute',
    description: 'route',
    iconPath: new vscode.ThemeIcon('symbol-method'),
    templateRouteLabel: ref.label,
    targetUri: vscode.Uri.file(ref.file),
    targetLine: ref.line,
  });
}

function makeOrphanItem(orphan: OrphanedTemplate): ExpressMapItem {
  return new ExpressMapItem({
    label: orphan.name,
    kind: 'orphan',
    description: 'never rendered',
    tooltip: new vscode.MarkdownString(`$(warning) This template is never referenced by \`res.render()\``, true),
    iconPath: new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')),
    contextValue: 'orphanTemplate',
    targetUri: vscode.Uri.file(orphan.file),
    targetLine: 1,
  });
}

function makeMiddlewareItem(mw: MiddlewareEntry): ExpressMapItem {
  return new ExpressMapItem({
    label: mw.name ?? '(anonymous)',
    kind: 'middleware',
    description: `${SCOPE_LABELS[mw.scope]} · ${shortPath(mw.file)}:${mw.line}`,
    tooltip: middlewareTooltip(mw),
    iconPath: new vscode.ThemeIcon('symbol-function'),
    targetUri: vscode.Uri.file(mw.file),
    targetLine: mw.line,
    middlewareData: mw,
  });
}

function makeDuplicateGroupItem(routes: Route[]): ExpressMapItem {
  const key = `${routes[0].method} ${routes[0].resolvedPath}`;
  return new ExpressMapItem({
    label: key,
    kind: 'duplicateGroup',
    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
    description: `${routes.length} conflicts`,
    tooltip: new vscode.MarkdownString(`$(warning) Multiple handlers for **${key}**`, true),
    iconPath: new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')),
    duplicateGroupData: routes,
  });
}

function makeDuplicateRouteItem(route: Route): ExpressMapItem {
  return new ExpressMapItem({
    label: shortPath(route.file),
    kind: 'duplicateRoute',
    description: `line ${route.line}`,
    tooltip: routeTooltip(route),
    iconPath: new vscode.ThemeIcon('symbol-method'),
    targetUri: vscode.Uri.file(route.file),
    targetLine: route.line,
    routeData: route,
  });
}

function makeEmptyItem(message: string, icon = 'info'): ExpressMapItem {
  return new ExpressMapItem({
    label: message,
    kind: 'empty',
    iconPath: new vscode.ThemeIcon(icon),
    contextValue: 'empty',
  });
}

function makeBrokenRefItem(ref: BrokenRef): ExpressMapItem {
  return new ExpressMapItem({
    label: `${ref.method}  ${ref.resolvedPath}`,
    kind: 'brokenRef',
    description: `→ '${ref.templateName}'`,
    tooltip: new vscode.MarkdownString(
      `$(error) Template not found: \`${ref.templateName}\`\n\nRoute: **${ref.method} ${ref.resolvedPath}**`, true,
    ),
    iconPath: new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground')),
    targetUri: vscode.Uri.file(ref.file),
    targetLine: ref.line,
  });
}

function makeIssueRouteItem(route: Route): ExpressMapItem {
  return new ExpressMapItem({
    label: `${route.method}  ${route.resolvedPath}`,
    kind: 'issueRoute',
    description: 'async · no try/catch',
    tooltip: new vscode.MarkdownString(
      `$(warning) **Async handler without error handling** (Express 4)\n\n` +
      `Express 4 does not catch rejected promises from route handlers. ` +
      `An uncaught async error hangs the request and, in Node 15+, crashes the process.\n\n` +
      `**Fix options:**\n` +
      `- Wrap the body in \`try { ... } catch (err) { next(err); }\`\n` +
      `- Use a wrapper: \`router.get('/path', asyncHandler(async (req, res) => {...}))\`\n` +
      `- Install \`express-async-errors\` to patch Express globally`,
      true,
    ),
    iconPath: new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')),
    contextValue: `route.${route.method.toLowerCase()}`,
    targetUri: vscode.Uri.file(route.file),
    targetLine: route.line,
    routeData: route,
  });
}

// ─── provider ─────────────────────────────────────────────────────────────────

export class ExpressMapProvider implements vscode.TreeDataProvider<ExpressMapItem> {

  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<ExpressMapItem | ExpressMapItem[] | undefined | null | void>();

  readonly onDidChangeTreeData: vscode.Event<ExpressMapItem | ExpressMapItem[] | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private data: ExpressApp | null = null;
  private noAppFound = false;

  // ── Item caches (populated in refresh(); required for treeView.reveal()) ───
  /** Stable Routes group item — same object instance returned by getRootChildren(). */
  private cachedRoutesGroup: ExpressMapItem | null = null;
  /** Top-level items under Routes (mix of prefix nodes and flat route items). */
  private routesTopLevel: ExpressMapItem[] = [];
  /** All route items keyed by `${file}:${line}` for O(1) lookup by reveal. */
  private cachedRouteItems = new Map<string, ExpressMapItem>();

  // ── public API ─────────────────────────────────────────────────────────────

  refresh(data: ExpressApp): void {
    this.data = data;
    this.noAppFound = false;
    this.cachedRoutesGroup = null;
    this.routesTopLevel = [];
    this.cachedRouteItems.clear();
    // Eagerly build route item tree so getRouteItem() works before the user expands the tree
    if (data.routes.length > 0) {
      this.cachedRoutesGroup = makeGroup('Routes', 'group', data.routes.length, 'list-unordered');
      this.routesTopLevel = this.buildRoutesChildren(data.routes, this.cachedRoutesGroup);
    }
    this._onDidChangeTreeData.fire();
  }

  setNoAppFound(): void {
    this.data = null;
    this.noAppFound = true;
    this.cachedRoutesGroup = null;
    this.routesTopLevel = [];
    this.cachedRouteItems.clear();
    this._onDidChangeTreeData.fire();
  }

  /** Returns the cached tree item for a route (used by extension.ts for reveal). */
  getRouteItem(route: Route): ExpressMapItem | undefined {
    return this.cachedRouteItems.get(`${route.file}:${route.line}`);
  }

  // ── TreeDataProvider implementation ────────────────────────────────────────

  getTreeItem(element: ExpressMapItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ExpressMapItem): ExpressMapItem[] {
    if (!element) {
      return this.getRootChildren();
    }
    return this.getItemChildren(element);
  }

  /** Required for treeView.reveal() — returns the parent item stored during construction. */
  getParent(element: ExpressMapItem): ExpressMapItem | undefined {
    return element.parentItem;
  }

  /** Implement resolveTreeItem to lazily upgrade tooltips if needed (satisfies the optional interface). */
  resolveTreeItem(
    item: vscode.TreeItem,
    _element: ExpressMapItem,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.TreeItem> {
    return item;
  }

  // ── private helpers ────────────────────────────────────────────────────────

  /**
   * Builds the items shown directly under the Routes group.
   * Groups routes by first path segment; segments with 2+ routes get a
   * collapsed prefix node. All route items are stored in cachedRouteItems
   * with their correct parentItem set so getParent() works for reveal().
   */
  private buildRoutesChildren(routes: Route[], routesGroup: ExpressMapItem): ExpressMapItem[] {
    function firstSegment(resolvedPath: string): string {
      return resolvedPath.split('/').filter(Boolean)[0] ?? '';
    }

    const segmentRoutes = new Map<string, Route[]>();
    for (const route of routes) {
      const seg = firstSegment(route.resolvedPath);
      const existing = segmentRoutes.get(seg);
      if (existing) { existing.push(route); }
      else { segmentRoutes.set(seg, [route]); }
    }

    const items: ExpressMapItem[] = [];
    const seen = new Set<string>();
    for (const route of routes) {
      const seg = firstSegment(route.resolvedPath);
      if (seen.has(seg)) { continue; }
      seen.add(seg);
      const group = segmentRoutes.get(seg)!;
      if (group.length >= 2) {
        const prefixLabel = seg ? `/${seg}` : '/';
        const prefixItem = makeRoutePrefixItem(prefixLabel, group, routesGroup);
        // Pre-build route items under this prefix and cache them
        for (const r of group) {
          const routeItem = makeRouteItem(r, prefixItem);
          this.cachedRouteItems.set(`${r.file}:${r.line}`, routeItem);
        }
        items.push(prefixItem);
      } else {
        const routeItem = makeRouteItem(route, routesGroup);
        this.cachedRouteItems.set(`${route.file}:${route.line}`, routeItem);
        items.push(routeItem);
      }
    }
    return items;
  }

  // ── root children ──────────────────────────────────────────────────────────

  private getRootChildren(): ExpressMapItem[] {
    if (this.noAppFound) {
      return [makeEmptyItem('No Express app found in workspace', 'warning')];
    }
    if (!this.data) {
      return [makeEmptyItem('Loading…', 'loading~spin')];
    }

    const { routes, middleware, templates, orphanedTemplates, duplicateRoutes, brokenRefs } = this.data;

    // Use the pre-built Routes group item so its identity is consistent with
    // the parentItem stored on cached route items — required for treeView.reveal().
    const routesGroup = this.cachedRoutesGroup ?? makeGroup('Routes', 'group', routes.length, 'list-unordered');
    if (!this.cachedRoutesGroup) { this.cachedRoutesGroup = routesGroup; }

    const groups: ExpressMapItem[] = [
      routesGroup,
      makeGroup('Templates', 'group', templates.length, 'file-code', true),
    ];

    const globalMw = middleware.filter(m => m.scope !== 'route');
    groups.push(makeGroup('Middleware', 'group', globalMw.length, 'symbol-function', true));

    if (orphanedTemplates.length > 0) {
      groups.push(makeGroup('Orphaned Templates', 'group', orphanedTemplates.length, 'warning', true));
    }
    if (duplicateRoutes.length > 0) {
      groups.push(makeGroup('Duplicate Routes', 'group', duplicateRoutes.length, 'warning', true));
    }
    if (brokenRefs.length > 0) {
      groups.push(makeGroup('Broken References', 'group', brokenRefs.length, 'error', true));
    }
    // Async issues are only meaningful in Express 4 without an async-error patch.
    // Express 5+ and express-async-errors both catch rejections automatically.
    if (!this.data.asyncErrorsSafe) {
      const asyncIssues = routes.filter(r => r.isAsync && !r.hasTryCatch);
      if (asyncIssues.length > 0) {
        groups.push(makeGroup('Potential Issues', 'group', asyncIssues.length, 'warning', true));
      }
    }

    return groups;
  }

  // ── children by kind ───────────────────────────────────────────────────────

  private getItemChildren(element: ExpressMapItem): ExpressMapItem[] {
    if (!this.data) { return []; }

    const { routes, middleware, templates, orphanedTemplates, duplicateRoutes, brokenRefs } = this.data;

    // Top-level groups — identified by label
    if (element.kind === 'group') {
      const label = typeof element.label === 'string' ? element.label : element.label?.label ?? '';
      switch (label) {
        case 'Routes':
          if (routes.length === 0) { return [makeEmptyItem('No routes detected')]; }
          // Return pre-built items; lazily build if refresh didn't run yet
          if (this.routesTopLevel.length === 0) {
            this.routesTopLevel = this.buildRoutesChildren(routes, element);
          }
          return this.routesTopLevel;

        case 'Templates':
          if (templates.length === 0) { return [makeEmptyItem('No templates found')]; }
          return templates.map(makeTemplateItem);

        case 'Middleware': {
          const globalMw = middleware.filter(m => m.scope !== 'route');
          if (globalMw.length === 0) { return [makeEmptyItem('No global or router middleware')]; }
          return globalMw.map(makeMiddlewareItem);
        }

        case 'Orphaned Templates':
          return orphanedTemplates.map(makeOrphanItem);

        case 'Duplicate Routes':
          return duplicateRoutes.map(makeDuplicateGroupItem);

        case 'Broken References':
          return brokenRefs.map(makeBrokenRefItem);

        case 'Potential Issues': {
          if (this.data?.asyncErrorsSafe) { return [makeEmptyItem('Async errors handled by framework')]; }
          const issues = routes.filter(r => r.isAsync && !r.hasTryCatch);
          if (issues.length === 0) { return [makeEmptyItem('No issues found')]; }
          return issues.map(makeIssueRouteItem);
        }

        default:
          return [];
      }
    }

    // Route prefix group → individual routes (return cached items built in refresh())
    if (element.kind === 'routePrefix' && element.routePrefixData) {
      return element.routePrefixData.map(r =>
        this.cachedRouteItems.get(`${r.file}:${r.line}`) ?? makeRouteItem(r, element),
      );
    }

    // Route item → middleware chain + template
    if (element.kind === 'route' && element.routeData) {
      const route = element.routeData;
      const children: ExpressMapItem[] = [];
      for (const mw of route.middleware) {
        children.push(makeRouteMiddlewareItem(mw));
      }
      if (route.templateName) {
        // Strip any template file extension that may appear in the render arg
        const tplName = (route.templateName ?? '').replace(/\.[a-z]+$/, '');
        const tpl = templates.find(t => t.name === tplName);
        const fileUri = tpl ? vscode.Uri.file(tpl.file) : undefined;
        children.push(makeRouteTemplateItem(route.templateName, fileUri));
      }
      return children;
    }

    // Template item → consuming routes
    if (element.kind === 'template' && element.templateData) {
      return element.templateData.usedByRoutes.map(makeTemplateRouteItem);
    }

    // Duplicate group → individual conflicting routes
    if (element.kind === 'duplicateGroup' && element.duplicateGroupData) {
      return element.duplicateGroupData.map(makeDuplicateRouteItem);
    }

    return [];
  }
}
