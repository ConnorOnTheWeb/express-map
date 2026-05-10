import * as vscode from 'vscode';
import { analyzeWorkspace } from './analyzer';
import { ExpressMapProvider, ExpressMapItem } from './treeProvider';
import type { ExpressApp, Route, Template } from './types';

// ─── constants ────────────────────────────────────────────────────────────────

const TREE_VIEW_ID = 'expressMapTree';
const REFRESH_COMMAND = 'expressMap.refresh';
const STATUS_BAR_ID = 'expressMap.status';
const FIRST_ACTIVATION_KEY = 'expressMap.firstActivationDone';
const DEBOUNCE_MS = 500;
const REVEAL_DEBOUNCE_MS = 600;
const LM_TOOL_NAME = 'express-map_analyzeApp';

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
  // Only emitted when Express 4 is in use without an async-error patch package.
  // Express 5+ and express-async-errors catch rejections automatically.
  if (!result.asyncErrorsSafe) {
    for (const route of result.routes) {
      if (route.isAsync && !route.hasTryCatch) {
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
  }

  for (const [file, diags] of byFile) {
    collection.set(vscode.Uri.file(file), diags);
  }
}

// ─── activate ────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  // ── Tree provider ──────────────────────────────────────────────────────────
  const provider = new ExpressMapProvider();

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
  let lastTemplatesByName = new Map<string, Template>();

  async function runAnalysis(): Promise<void> {
    if (!workspaceFolder) {
      provider.setNoAppFound();
      statusBar.text = '$(warning) No workspace';
      statusBar.tooltip = 'Express Map: no workspace folder open';
      treeView.badge = undefined;
      return;
    }

    const root = workspaceFolder.uri.fsPath;
    let result;
    try {
      result = await analyzeWorkspace(root);
    } catch (err) {
      provider.setNoAppFound();
      statusBar.text = '$(warning) Analysis failed';
      statusBar.tooltip = new vscode.MarkdownString(
        `Express Map analysis error:\n\n\`${String(err)}\``,
      );
      treeView.badge = undefined;
      return;
    }

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
    lastTemplatesByName = new Map(result.templates.map(t => [t.name, t]));

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
  if (workspaceFolder) {
    // Broad pattern covers JS/TS source and all known template engine extensions.
    // Being broad is safe — extra triggers just re-run static analysis.
    const pattern = new vscode.RelativePattern(
      workspaceFolder,
      '**/*.{js,ts,mjs,cjs,ejs,pug,jade,hbs,handlebars,mustache,njk,twig,liquid,eta}',
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
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
            const tpl = lastTemplatesByName.get(tplName);
            if (!tpl) { continue; }
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
  let revealDebounce: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (!lastResult) { return; }
      const filePath = e.textEditor.document.uri.fsPath;
      // Only trigger for files that contain known routes (skip everything else)
      if (!lastRouteFilePaths.has(filePath)) { return; }
      clearTimeout(revealDebounce);
      revealDebounce = setTimeout(() => {
        if (!lastResult) { return; }
        const cursor = e.textEditor.selection.active.line + 1; // convert to 1-based
        // Find the route whose declaration is closest above (or at) the cursor.
        // Routes within a file are in ascending source order — iterate without sort.
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
      }, REVEAL_DEBOUNCE_MS);
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

        const workspaceRoot = workspaceFolder?.uri.fsPath ?? '';
        const relativePath = (abs: string): string =>
          abs.startsWith(workspaceRoot)
            ? abs.slice(workspaceRoot.length).replace(/\\/g, '/').replace(/^\//, '')
            : abs;

        const summary = {
          summary: {
            routes: lastResult.routes.length,
            templates: lastResult.templates.length,
            brokenTemplateRefs: lastResult.brokenRefs.length,
            asyncWithoutTryCatch: lastResult.routes.filter(r => r.isAsync && !r.hasTryCatch).length,
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
            .filter(r => r.isAsync && !r.hasTryCatch)
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
