# Change Log

All notable changes to Express Map are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.2.0] — 2026-08-12

### Fixed

- **Route handlers wrapped in a helper were analysed as the wrapper, not the handler.** `app.get('/x', asyncHandler(async (req, res) => …))` registers a `CallExpression`, not a function, and every read of a handler goes through `isFunctionLike` first. So a wrapped route came out with `isAsync: false` — reported as synchronous in the tree tooltip and to the Copilot tool — regardless of the `async` sitting right there in the source.

  The costlier half was template detection. `getResParamName` is called only when the handler is function-like and otherwise falls back to the literal string `res`, so a wrapped handler whose response parameter was named anything else had its `res.render()` calls go unrecognised: no template on the route, no CodeLens `renders …`, no clickable link, and the template itself counted as **orphaned** because nothing appeared to reference it. `asyncHandler(async (req, reply) => reply.render('dash'))` produced a route with no template and an orphan entry for `dash`.

  A one-argument call whose only argument is a function literal is now unwrapped, and everything downstream reads the function inside it. The shape is deliberately narrow rather than matched against a list of wrapper names — `asyncHandler`, `catchAsync`, `wrapAsync`, `express-async-handler` and every in-house equivalent share that shape, and the list of names has no end.

  Measured against the real analyser on a fixture app: before, `/wrapped` reported `isAsync: false`, `templateName: undefined`, `responseType: 'unknown'`. After, `true`, `'dash'`, `'render'`. Four assertions changed and no others.

### Changed

- **No new warnings, by construction.** Seeing a wrapped handler as async for the first time would otherwise have exposed it to the async-without-try/catch check — turning a data fix into a wave of warnings on code that was never flagged before. Routes resolved through a wrapper are marked `wrappedHandler` and are exempt: a wrapper taking a single handler exists to do something with what that handler throws, and its body isn't visible from the call site to prove otherwise.

  The set of warnings is identical to 1.1.0 for every input, not merely similar. A warning could only have fired when `isAsync` was true, which required the handler to be function-like, which means it was never a wrapper call and unwrapping is a no-op for it. Confirmed by measurement rather than argument: with the unwrap disabled, exactly four assertions in the new suite fail and the async-issue assertions are not among them.

- **A two-argument call is not a wrapper.** `withOptions(handler, { retries: 2 })` is left alone, since the second argument means the call is doing something other than adapting a handler and its return value can't be assumed to be one. Covered by a test in that direction.

### Added

- **A test suite for the analyser** (`npm run test:analyzer`), replacing the generated placeholder that asserted `[1,2,3].indexOf(5) === -1`. `analyzer.ts` imports no `vscode` API — only `fs`, `path` and Babel — so the tests write a real Express app to a temp directory and read it off disk, with no extension host and no downloaded VS Code build. A hand-built AST wouldn't have exercised entry-point discovery, the require walk or the views scan, which is where these bugs live.

  24 checks: the four route shapes (bare async, wrapped async, async with try/catch, synchronous) against `isAsync`, `hasTryCatch`, `wrappedHandler`, `templateName`, `responseType` and the async-issue predicate, the two-argument non-wrapper, and the template walk with and without `excludeDirs`.

---

## [1.1.0] — 2026-08-12

### Added

- **Settings, for the first time.** The extension contributed no `configuration` block and called `getConfiguration` nowhere. "No configuration required" is the right default and still holds — every setting here defaults to existing behaviour — but it had become "no configuration possible", and the two diagnostics land in the Problems panel with no way to silence them.

  | Setting | Default |
  |---|---|
  | `expressMap.diagnostics.brokenTemplateRef.severity` | `error` |
  | `expressMap.diagnostics.asyncErrorHandling.severity` | `warning` |
  | `expressMap.excludeDirs` | `[]` |

  Deliberately not settings: the views directory, template engine and entry point, all of which are discovered from the app itself and must not become the user's problem, and the route grouping, which is already a one-click control that remembers its own state.

- **Severity enums rather than on/off booleans**, with `hint` as the value that earns the enum — underline in the editor, no entry in the Problems panel. `error`, `warning`, `information` and `off` are the rest.

- **`expressMap.excludeDirs`, for directories the template walk shouldn't descend into.** `node_modules`, `.git` and `out` were hardcoded in two separate walks, so a build step that copies compiled templates into the views tree produced duplicate and orphaned entries with no way to suppress them. These are directory *names* rather than globs, because names are what the walk compares as it descends.

- **Both tree sections are unaffected by the severity settings.** Turning a diagnostic off removes it from the Problems panel and the editor; **Broken References** and **Potential Issues** still list what was found. The panel is a place you go to look, not something that interrupts you, so silencing a squiggle shouldn't also hide the inventory.

### Changed

- **The async-issue condition lives in one place now.** `isAsync && !hasTryCatch && !asyncErrorsSafe` had been written out by hand in five places — the diagnostic, the Copilot tool's summary count and its issue list, and three groupings in the tree. Any change to it had to land in all five or the Problems entry, the tree badge and the AI summary would disagree about the same route. It is now a single `hasAsyncIssue` predicate that all five call, which is what made the 1.2.0 change to it a one-line edit instead of a five-site hunt.

- **Analysis re-runs on a settings change, but only when it has to.** `excludeDirs` changes which files are read and triggers a full re-analysis; a severity change only affects how the last result is reported and reuses it. Doing nothing would have left squiggles in place after a check was turned off, which reads as the setting not working.

- **Diagnostic severity is resolved per source file** rather than once per run, so a multi-root window can turn a check off for one project and keep it in the others. `excludeDirs` is window-scoped instead, since analysis runs per project root rather than per open file.

- **`analyzeWorkspace` takes an options argument** (`analyzeWorkspace(root, { excludeDirs })`), keeping `analyzer.ts` free of the `vscode` import. Reading settings inside it would have made the analyser untestable outside an extension host, which is what the 1.2.0 test suite depends on.

---

## [1.0.11] — 2026-05-31

### Added

- **Catch-all Handlers section.** `app.use()` handlers registered globally (at `/`) without a named function are now classified as catch-all handlers rather than ordinary middleware and appear in a separate **Catch-all Handlers** group in the tree. This keeps the Middleware list clean and clearly distinguishes terminal handlers (404 handler, error handler) from pipeline middleware.
- **Smart naming for catch-all handlers.** Anonymous inline functions no longer show `(anonymous)` — they are automatically named by inspecting their signature and body:
  - 4-parameter signature `(err, req, res, next)` → `error handler`
  - Body calls `res.status(404)` or `res.sendStatus(404)` → `404 handler`
  - Other 4xx/5xx status codes → e.g. `500 handler`
  - Any other catch-all inline function → `catch-all handler`

## [1.0.10] — 2026-05-31

### Fixed

- **Clicking middleware / template / orphan items no longer hijacks the route selection.** Previously, clicking any non-route tree item (anonymous middleware, named middleware, template, orphan, etc.) would open the correct file at the correct line, but then the auto-reveal debounce would fire and overwrite the tree selection with the nearest route above that line — making it appear as though clicking middleware jumped to a random unrelated route. The fix: `onDidChangeTextEditorSelection` now exits immediately when `e.kind === TextEditorSelectionChangeKind.Command`, which is the kind VS Code assigns when a selection is placed programmatically (via `vscode.open`). Genuine user navigation (keyboard and mouse) still triggers auto-reveal normally.

## [1.0.9] — 2026-05-30

### Fixed

- **Auto-reveal no longer hijacks the sidebar.** Previously, moving the cursor inside a route file would call `treeView.reveal()` even when the Express Map panel was not visible, causing VS Code to switch the sidebar away from the File Explorer (or any other active panel). The auto-reveal handler now checks `treeView.visible` first and skips the reveal entirely when Express Map is not the active panel.
- **Instant sync on panel open.** A new `treeView.onDidChangeVisibility` listener detects when the user manually switches to Express Map and immediately highlights the route under the current cursor — so the tree is always in the right place the moment the panel becomes visible.

## [1.0.8] - 2026-05-19

### Changed

- bump to keep changelog current

## [1.0.7] — 2026-05-19

### Changed

- package.json engine version updated to support Open VSX and Cursor.

## [1.0.6] — 2026-05-16

### Changed

- README: added VS Marketplace version, license, and TypeScript badges.

---

## [1.0.5] — 2026-05-15

### Added
- **Configurable route grouping**: a `$(list-filter)` button in the Express Map panel header opens a Quick Pick to switch between three grouping modes:
  - **By Prefix** *(default)* — groups routes by their first path segment, identical to the previous behaviour
  - **By File** — groups routes by the source file they are defined in
  - **By Method** — groups routes by HTTP method (GET, POST, PUT, PATCH, DELETE, …)

  The selected mode is persisted across sessions.

## [1.0.4] — 2026-05-15

### Changed
- **Project-first tree layout** (multi-project): in workspaces with multiple Express apps, each project is now the top-level item in the Express Map panel. Routes, Templates, Middleware, Orphaned Templates, Duplicate Routes, Broken References, and Potential Issues are all grouped **under** their respective project folder rather than as flat sections alongside Routes. Single-project workspaces are unchanged.

## [1.0.3] — 2026-05-15

### Added
- **Route search** (`expressMap.searchRoutes`): fuzzy Quick Pick over all routes — searchable by HTTP method, path, file path, and rendered template name. Accessible via the search icon in the Express Map panel header, the Command Palette (*Express Map: Search Routes*), or **Cmd+Shift+F** / **Ctrl+Shift+F** when the Express Map panel is focused. Selecting a result opens the source file at the route's definition line and reveals it in the tree.

## [1.0.2] — 2026-05-15

### Added
- **Multi-project tree grouping**: when a workspace contains multiple Express projects (parent-directory or multi-root window), routes are now separated into per-project folder nodes in the tree rather than merged into one flat list. Each folder is labelled with the project directory name and shows its route count.

## [1.0.1] — 2026-05-15

### Added
- **Multi-project / monorepo support**: the extension now works when VS Code is opened on a parent directory containing multiple Express apps, or when a multi-root workspace includes several Express projects. All `workspaceFolders` are scanned; for each one, if the folder itself is not an Express project its immediate sub-directories are checked. All discovered Express roots are analysed and merged into a single tree.

## [1.0.0] — 2026-05-10

### Added
- **Route Tree**: interactive tree grouping all Express routes by path prefix, with HTTP method icons, source file locations, and click-to-navigate
- **Middleware layer**: global and router-scoped middleware listed per-route and in a top-level Middleware group
- **Template navigation**: `res.render()` string arguments become Cmd/Ctrl-clickable document links that open the template file
- **CodeLens**: inline route labels above each handler (`GET /path · N middleware · renders view`) with click-to-reveal
- **Auto-reveal**: cursor position in route files automatically highlights the corresponding route in the tree
- **Broken References**: `res.render()` calls whose template file does not exist flagged as errors (editor squiggle + Problems panel + tree section)
- **Potential Issues**: async route handlers without `try/catch` flagged as warnings (editor squiggle + Problems panel + tree section)
- **Orphaned Templates**: template files never referenced by any `res.render()` call surfaced in the tree
- **Duplicate Routes**: multiple handlers for the same `METHOD /path` grouped and highlighted
- **Multi-engine support**: EJS, Pug/Jade, Handlebars/HBS, Mustache, Nunjucks, Twig, Liquid, Eta; auto-detects engine from views directory when not explicitly set
- **Route prefix grouping**: routes sharing a first path segment are collapsed under a prefix node
- **Copy Route Path** command: inline copy icon on route items writes the resolved path to the clipboard
- **Filter on type**: built-in tree filtering activated by typing in the Express Map panel
- **File watcher**: tree and diagnostics refresh automatically on source or template file changes
- **Activity bar badge**: route count shown on the Express Map icon
- **Express 4 + 5 support**: detects Express version from `package.json`; suppresses async-error warnings for Express 5+ (which catches rejections automatically); shows version in status bar tooltip
- **Express 5 path syntax**: `{:name}` optional params and `{*name}` named wildcards recognised and displayed correctly
- **Array mount paths**: `app.use(['/api', '/v2'], router)` and `app.get(['/a', '/b'], handler)` supported
- **Copilot LM tool** (`#express-map_analyzeApp`): exposes full structured app analysis to GitHub Copilot Chat — invoke explicitly with `#express-map_analyzeApp` in a chat message; the tool is **opt-in only** and never sends route or template data to the model automatically, protecting the privacy of your app's internal structure
- **Workspace trust**: declared as `limited` — static analysis only, never executes user code
