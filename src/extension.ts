import * as vscode from 'vscode';
import { analyzeWorkspace, findExpressRoots, mergeExpressApps } from './analyzer';
import { ExpressMapProvider, ExpressMapItem } from './treeProvider';
import type { Grouping } from './treeProvider';
import type { ExpressApp, Route, Template } from './types';

// ─── constants ────────────────────────────────────────────────────────────────

const TREE_VIEW_ID = 'expressMapTree';
const REFRESH_COMMAND = 'expressMap.refresh';
const SEARCH_COMMAND = 'expressMap.searchRoutes';
const STATUS_BAR_ID = 'expressMap.status';
const FIRST_ACTIVATION_KEY = 'expressMap.firstActivationDone';
const DEBOUNCE_MS = 500;
const REVEAL_DEBOUNCE_MS = 600;
const LM_TOOL_NAME = 'express-map_analyzeApp';

const ROUTE_METHOD_ICONS: Record<string, string> = {
  GET: 'arrow-down', POST: 'arrow-up', PUT: 'edit', PATCH: 'diff-modified',
  DELETE: 'trash', HEAD: 'eye', OPTIONS: 'settings', ALL: 'globe',
};

// ─── diagnostics helper ───────────────────────────────────────────────────────

function updateDiagnostics(
  collection: vscode.DiagnosticCollection,
  result: ExpressApp,
): void {
  collection.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();

  const push = (file: string, diag: vscode.Diagnostic): void => {
    const list = byFile.get(file) ?? [];
    list.push(diag);
    byFile.set(file, list);
  };

  // Broken template references — error severity
  for (const ref of result.brokenRefs) {
    const diag = new vscode.Diagnostic(
      new vscode.Range(ref.line - 1, 0, ref.line - 1, Number.MAX_SAFE_INTEGER),
      `Express Map: template '${ref.templateName}' not found in views directory`,
      vscode.DiagnosticSeverity.Error,
    );
    diag.source = 'Express Map';
    diag.code = 'broken-template-ref';
    push(ref.file, diag);
  }

  // Async handlers without try/catch — warning severity
  // Uses the per-route asyncErrorsSafe flag so multi-project workspaces don't
  // produce false positives: Express 5 routes are never warned even when a
  // sibling project uses Express 4 without an async-error patch.
  for (const route of result.routes) {
    if (route.isAsync && !route.hasTryCatch && !route.asyncErrorsSafe) {
      const diag = new vscode.Diagnostic(
        new vscode.Range(route.line - 1, 0, route.line - 1, Number.MAX_SAFE_INTEGER),
        `Express Map: async route ${route.method} ${route.resolvedPath} has no try/catch — ` +
          `unhandled rejections hang the request and crash the server (Express 4 / Node 15+)`,
        vscode.DiagnosticSeverity.Warning,
      );
      diag.source = 'Express Map';
      diag.code = 'async-no-error-handling';
      push(route.file, diag);
    }
  }

  for (const [file, diags] of byFile) {
    collection.set(vscode.Uri.file(file), diags);
  }
}

// ─── activate ────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── Tree provider ──────────────────────────────────────────────────────────
  const savedGrouping = (context.globalState.get<string>('expressMap.treeGrouping') ?? 'prefix') as Grouping;
  const provider = new ExpressMapProvider(savedGrouping);

  const treeView = vscode.window.createTreeView<ExpressMapItem>(TREE_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  // ── Status bar ─────────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    STATUS_BAR_ID,
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.name = 'Express Map';
  statusBar.command = REFRESH_COMMAND;
  statusBar.show();

  context.subscriptions.push(treeView, statusBar);

  // ── Analysis runner ────────────────────────────────────────────────────────

  // ── Diagnostics collection ────────────────────────────────────────────────────
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('expressMap');
  context.subscriptions.push(diagnosticCollection);

  let lastRouteCount = 0;
  let lastResult: ExpressApp | null = null;

  // Precomputed O(1) lookup structures — rebuilt after each analysis run.
  // DocumentLinkProvider, CodeLensProvider, and auto-reveal all hot-path these.
  let lastRoutesByFile = new Map<string, Route[]>();
  let lastRouteFilePaths = new Set<string>();
  // Multi-value map: template names are not unique across projects, so each
  // name maps to all templates with that name (one per project at most).
  let lastTemplatesByName = new Map<string, Template[]>();

  async function runAnalysis(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      provider.setNoAppFound();
      statusBar.text = '$(warning) No workspace';
      statusBar.tooltip = 'Express Map: no workspace folder open';
      treeView.badge = undefined;
      return;
    }

    // Collect Express project roots from every workspace folder (Option 2) and
    // their immediate sub-directories (Option 3) so that both multi-root
    // workspaces and parent-directory windows work out of the box.
    // Use a Set for O(1) deduplication instead of O(n) Array.includes.
    const expressRootsSet = new Set<string>();
    for (const folder of folders) {
      for (const root of findExpressRoots(folder.uri.fsPath)) {
        expressRootsSet.add(root);
      }
    }
    const expressRoots = [...expressRootsSet];

    if (expressRoots.length === 0) {
      provider.setNoAppFound();
      diagnosticCollection.clear();
      statusBar.text = '$(warning) No Express app found';
      statusBar.tooltip = 'Express Map: no Express entry point detected in workspace';
      treeView.badge = undefined;
      return;
    }

    let results: ExpressApp[];
    try {
      results = await Promise.all(expressRoots.map(root => analyzeWorkspace(root)));
    } catch (err) {
      provider.setNoAppFound();
      statusBar.text = '$(warning) Analysis failed';
      statusBar.tooltip = new vscode.MarkdownString(
        `Express Map analysis error:\n\n\`${String(err)}\``,
      );
      treeView.badge = undefined;
      return;
    }

    const result = mergeExpressApps(results);

    if (result.routes.length === 0) {
      provider.setNoAppFound();
      diagnosticCollection.clear();
      statusBar.text = '$(warning) No Express app found';
      statusBar.tooltip = 'Express Map: no Express entry point detected in workspace';
      treeView.badge = undefined;
      return;
    }

    provider.refresh(result);
    lastResult = result;

    // Rebuild lookup indices — O(routes + templates), amortises cost for all provider calls
    lastRoutesByFile = new Map<string, Route[]>();
    for (const r of result.routes) {
      const list = lastRoutesByFile.get(r.file);
      if (list) { list.push(r); } else { lastRoutesByFile.set(r.file, [r]); }
    }
    lastRouteFilePaths = new Set(result.routes.map(r => r.file));
    lastTemplatesByName = new Map<string, Template[]>();
    for (const t of result.templates) {
      const list = lastTemplatesByName.get(t.name);
      if (list) { list.push(t); } else { lastTemplatesByName.set(t.name, [t]); }
    }

    updateDiagnostics(diagnosticCollection, result);

    const n = result.routes.length;
    lastRouteCount = n;
    statusBar.text = `$(map) ${n} route${n !== 1 ? 's' : ''}`;
    statusBar.tooltip = new vscode.MarkdownString(
      `**Express Map**\n\n` +
      `${n} route${n !== 1 ? 's' : ''} · ${result.middleware.length} middleware · ` +
      `${result.templates.length} template${result.templates.length !== 1 ? 's' : ''}` +
      (result.expressVersion ? `\n\nExpress ${result.expressVersion}` : '') +
      (result.asyncErrorsSafe ? '  ·  async errors handled by framework' : ''),
      true,
    );

    // TreeView badge — shows route count on the activity bar icon
    treeView.badge = { value: n, tooltip: `${n} Express route${n !== 1 ? 's' : ''} found` };
  }

  // ── Refresh command ────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_COMMAND, () => {
      runAnalysis().catch(err =>
        console.error('[Express Map] Refresh error:', err),
      );
    }),
  );

  // ── File watcher with debounce ─────────────────────────────────────────────
  // A global watcher (no RelativePattern) automatically covers every workspace
  // folder including ones added later via multi-root workspaces.
  {
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{js,ts,mjs,cjs,ejs,pug,jade,hbs,handlebars,mustache,njk,twig,liquid,eta}',
    );
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const onFileChange = (): void => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        runAnalysis().catch(err =>
          console.error('[Express Map] Watcher-triggered analysis error:', err),
        );
      }, DEBOUNCE_MS);
    };

    watcher.onDidChange(onFileChange, undefined, context.subscriptions);
    watcher.onDidCreate(onFileChange, undefined, context.subscriptions);
    watcher.onDidDelete(onFileChange, undefined, context.subscriptions);
    context.subscriptions.push(watcher);
  }

  // Re-analyse when workspace folders are added or removed
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      runAnalysis().catch(err =>
        console.error('[Express Map] Workspace-folders-change analysis error:', err),
      );
    }),
  );

  // ── Template document links (click on res.render strings opens template file) ───
  // DocumentLinkProvider lets us control the exact underline range so the full
  // quoted template name (e.g. 'map/index') shows as ONE link, not two
  // word-token underlines split at '/' as DefinitionProvider produces.
  const templateLinkLanguages = [
    { scheme: 'file', language: 'javascript' },
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'javascriptreact' },
    { scheme: 'file', language: 'typescriptreact' },
  ];
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      templateLinkLanguages,
      {
        provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
          if (!lastResult) { return []; }
          // Scan full document text so multi-line .render(\n  'name') is handled
          const text = document.getText();
          const re = /\.render\s*\(\s*(['"`])([^'"`\n]+)\1/g;
          const links: vscode.DocumentLink[] = [];
          let match: RegExpExecArray | null;
          while ((match = re.exec(text)) !== null) {
            const tplName = match[2].replace(/\.[a-z]+$/, '');  // normalise: strip any extension
            const candidates = lastTemplatesByName.get(tplName);
            if (!candidates || candidates.length === 0) { continue; }
            // When multiple projects share a template name, prefer the one
            // that lives under the same project root as the open document.
            const docFsPath = document.uri.fsPath;
            const tpl = candidates.find(c => c.projectRoot &&
              (docFsPath.startsWith(c.projectRoot + '/') || docFsPath.startsWith(c.projectRoot + '\\')))
              ?? candidates[0];
            // Offset of first char of template name (right after the opening quote).
            // match[0] ends with: <quote><name><quote> so name starts at
            // match.index + match[0].length - match[2].length - 1
            const nameOffset = match.index + match[0].length - match[2].length - 1;
            const link = new vscode.DocumentLink(
              new vscode.Range(
                document.positionAt(nameOffset),
                document.positionAt(nameOffset + match[2].length),
              ),
              vscode.Uri.file(tpl.file),
            );
            link.tooltip = `Open ${tpl.name}`;
            links.push(link);
          }
          return links;
        },
      },
    ),
  );

  // ── Copy route path command ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('expressMap.copyRoutePath', (item?: ExpressMapItem) => {
      const route = item?.routeData;
      if (!route) { return; }
      vscode.env.clipboard.writeText(route.resolvedPath).then(() => {
        vscode.window.setStatusBarMessage(`$(copy) Copied: ${route.resolvedPath}`, 2000);
      }, () => { /* clipboard unavailable */ });
    }),
  );
  // ── Change grouping command (Quick Pick) ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('expressMap.changeGrouping', async () => {
      const current = provider.getGrouping();
      const options: Array<{ label: string; description: string; value: Grouping }> = [
        { label: '$(list-tree)\u00a0 By Prefix', description: 'Group by first path segment', value: 'prefix' },
        { label: '$(file-code)\u00a0 By File',   description: 'Group by source file',        value: 'file' },
        { label: '$(symbol-method)\u00a0 By Method', description: 'Group by HTTP method (GET, POST…)', value: 'method' },
      ];
      const picked = await vscode.window.showQuickPick(
        options.map(o => ({ ...o, detail: o.value === current ? '$(check) current' : undefined })),
        { placeHolder: 'Group routes by…' },
      );
      if (!picked) { return; }
      provider.setGrouping(picked.value);
      context.globalState.update('expressMap.treeGrouping', picked.value);
    }),
  );
  // ── Search routes command (Quick Pick) ──────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(SEARCH_COMMAND, async () => {
      if (!lastResult || lastResult.routes.length === 0) {
        vscode.window.showInformationMessage('Express Map: no routes found yet.');
        return;
      }
      const items = lastResult.routes.map(r => ({
        label: `$(${ROUTE_METHOD_ICONS[r.method] ?? 'symbol-method'})\u00a0 ${r.method}  ${r.resolvedPath}`,
        description: vscode.workspace.asRelativePath(r.file),
        detail: r.templateName ? `renders ${r.templateName}` : undefined,
        route: r,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: `Search ${lastResult.routes.length} routes…`,
      });
      if (!picked) { return; }
      // Open the source file at the route definition line
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(picked.route.file));
      const editor = await vscode.window.showTextDocument(doc);
      const pos = new vscode.Position(Math.max(0, picked.route.line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      // Also reveal in the tree if it’s visible
      const routeItem = provider.getRouteItem(picked.route);
      if (routeItem) {
        treeView.reveal(routeItem, { select: true, focus: false, expand: true })
          .then(undefined, () => { /* tree not visible — ignore */ });
      }
    }),
  );
  // ── Internal: reveal a route in the tree (used by CodeLens click) ───────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'expressMap.revealRoute',
      async (file: string, line: number) => {
        if (!lastResult) { return; }
        const route = lastResult.routes.find(r => r.file === file && r.line === line);
        if (!route) { return; }
        const item = provider.getRouteItem(route);
        if (!item) { return; }
        try {
          await treeView.reveal(item, { select: true, focus: true, expand: true });
        } catch { /* tree may not be visible */ }
      },
    ),
  );

  // ── CodeLens: show route info inline above each handler in source files ───
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      templateLinkLanguages,
      {
        provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
          if (!lastResult) { return []; }
          const filePath = document.uri.fsPath;
          return (lastRoutesByFile.get(filePath) ?? [])
            .map(r => {
              const line = Math.max(0, r.line - 1);
              const range = new vscode.Range(line, 0, line, 0);
              const parts: string[] = [`${r.method} ${r.resolvedPath}`];
              if (r.middleware.length) { parts.push(`${r.middleware.length} middleware`); }
              if (r.templateName) { parts.push(`renders ${r.templateName}`); }
              else if (r.responseType !== 'unknown') { parts.push(r.responseType); }
              return new vscode.CodeLens(range, {
                title: parts.join(' · '),
                command: 'expressMap.revealRoute',
                arguments: [r.file, r.line],
                tooltip: 'Click to reveal in Express Map',
              });
            });
        },
      },
    ),
  );

  // ── Auto-reveal: highlight active route in tree as cursor moves ───────────
  // Helper: reveal the route closest above the cursor in the given editor.
  // Returns without doing anything if the tree is not currently visible —
  // this prevents treeView.reveal() from stealing the sidebar away from the
  // File Explorer (or any other panel) while the user is working there.
  function revealActiveRoute(editor: vscode.TextEditor): void {
    if (!lastResult) { return; }
    if (!treeView.visible) { return; }
    const filePath = editor.document.uri.fsPath;
    if (!lastRouteFilePaths.has(filePath)) { return; }
    const cursor = editor.selection.active.line + 1; // 1-based
    const fileRoutes = lastRoutesByFile.get(filePath) ?? [];
    let route: Route | undefined;
    for (const r of fileRoutes) {
      if (r.line <= cursor) { route = r; }
    }
    if (!route) { return; }
    const routeItem = provider.getRouteItem(route);
    if (!routeItem) { return; }
    treeView.reveal(routeItem, { select: true, focus: false, expand: false })
      .then(undefined, () => { /* tree not visible — ignore */ });
  }

  let revealDebounce: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      // Skip entirely when Express Map isn't the active sidebar panel so we
      // never cause the sidebar to switch away from the File Explorer.
      if (!treeView.visible) { return; }
      if (!lastResult) { return; }
      const filePath = e.textEditor.document.uri.fsPath;
      // Only trigger for files that contain known routes (skip everything else)
      if (!lastRouteFilePaths.has(filePath)) { return; }
      clearTimeout(revealDebounce);
      revealDebounce = setTimeout(() => {
        revealActiveRoute(e.textEditor);
      }, REVEAL_DEBOUNCE_MS);
    }),
  );

  // When the user manually switches the sidebar to Express Map, immediately
  // sync the tree to wherever the cursor currently is — so the view is always
  // in the right place the moment it becomes visible.
  context.subscriptions.push(
    treeView.onDidChangeVisibility(e => {
      if (!e.visible) { return; }
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }
      revealActiveRoute(editor);
    }),
  );

  // ── Language model tool (exposes analysis data to Copilot / AI tools) ──────
  // Copilot can call this tool during chat when the user asks about routes,
  // templates, or issues. Also referenceable as #express-map_analyzeApp.
  context.subscriptions.push(
    vscode.lm.registerTool(LM_TOOL_NAME, {
      async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
        _token: vscode.CancellationToken,
      ): Promise<vscode.LanguageModelToolResult> {
        if (!lastResult) {
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              JSON.stringify({ error: 'No Express app analysed yet. Trigger a refresh first.' }),
            ),
          ]);
        }

        const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
        const relativePath = (abs: string): string =>
          vscode.workspace.asRelativePath(abs, multiRoot);

        const summary = {
          summary: {
            routes: lastResult.routes.length,
            templates: lastResult.templates.length,
            brokenTemplateRefs: lastResult.brokenRefs.length,
            asyncWithoutTryCatch: lastResult.routes.filter(r => r.isAsync && !r.hasTryCatch && !r.asyncErrorsSafe).length,
            duplicateRoutes: lastResult.duplicateRoutes.length,
            orphanedTemplates: lastResult.orphanedTemplates.length,
            viewEngine: lastResult.viewEngine || 'unknown',
            viewsDir: relativePath(lastResult.viewsDir),
            expressVersion: lastResult.expressVersion || 'unknown',
            asyncErrorsSafe: lastResult.asyncErrorsSafe,
          },
          routes: lastResult.routes.map(r => ({
            method: r.method,
            path: r.resolvedPath,
            file: relativePath(r.file),
            line: r.line,
            responseType: r.responseType,
            template: r.templateName ?? null,
            isAsync: r.isAsync,
            hasTryCatch: r.hasTryCatch,
            middlewareCount: r.middleware.length,
          })),
          brokenTemplateRefs: lastResult.brokenRefs.map(b => ({
            method: b.method,
            path: b.resolvedPath,
            missingTemplate: b.templateName,
            file: relativePath(b.file),
            line: b.line,
          })),
          asyncWithoutTryCatch: lastResult.routes
            .filter(r => r.isAsync && !r.hasTryCatch && !r.asyncErrorsSafe)
            .map(r => ({ method: r.method, path: r.resolvedPath, file: relativePath(r.file), line: r.line })),
          duplicateRoutes: lastResult.duplicateRoutes.map(group =>
            group.map(r => ({ method: r.method, path: r.resolvedPath, file: relativePath(r.file), line: r.line }))
          ),
          orphanedTemplates: lastResult.orphanedTemplates.map(t => ({
            name: t.name,
            file: relativePath(t.file),
          })),
        };

        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(JSON.stringify(summary, null, 2)),
        ]);
      },
    }),
  );

  // ── Initial analysis ───────────────────────────────────────────────────────
  await runAnalysis();

  // ── First-activation message (shown once per workspace) ───────────────────
  const alreadyShown = context.workspaceState.get<boolean>(FIRST_ACTIVATION_KEY, false);
  if (!alreadyShown) {
    await context.workspaceState.update(FIRST_ACTIVATION_KEY, true);
    if (lastRouteCount > 0) {
      const n = lastRouteCount;
      vscode.window.showInformationMessage(
        `Express Map is active. ${n} route${n !== 1 ? 's' : ''} found.`,
      );
    }
  }
}

// ─── deactivate ───────────────────────────────────────────────────────────────

export function deactivate(): void {
  // VS Code disposes everything in context.subscriptions automatically.
  // Nothing additional to clean up.
}
