# Change Log

All notable changes to Express Map are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
