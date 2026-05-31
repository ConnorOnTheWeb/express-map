# Change Log

All notable changes to Express Map are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
