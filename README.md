# Express Map

**Visual route, middleware, and template navigation for Express.js apps inside VS Code and IDEs forked from VSC.**

Express Map statically analyses your Express application and renders an interactive tree of every route, middleware layer, and template file. No running server needed, no configuration required - just open your project and the map appears.

[![VS Marketplace](https://vsmarketplacebadges.dev/version/connorontheweb.express-map.svg)](https://marketplace.visualstudio.com/items?itemName=connorontheweb.express-map) [![License](https://img.shields.io/github/license/connorontheweb/express-map)](https://github.com/connorontheweb/express-map/blob/main/LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[![Latest Release](https://img.shields.io/github/v/release/connorontheweb/express-map?label=download&logo=github)](https://github.com/connorontheweb/express-map/releases/latest)

---

## Features

### Route Tree
All routes are grouped by path prefix and displayed with their HTTP method, resolved path, source file, and middleware chain. Click any route to jump to its definition.

### Template Navigation
`res.render('some/view')` calls become clickable links - hold **Cmd** (macOS) or **Ctrl** (Windows/Linux) and click the template name in your source file to open the template directly.

### CodeLens
Route metadata appears inline above each handler function:

```
GET /admin/users · 2 middleware · renders admin/users
```

Click the CodeLens label to reveal that route in the Express Map panel.

### Auto-Reveal
As you move the cursor through a route file, the corresponding route is highlighted in the tree automatically — but only when the Express Map panel is already the active sidebar view. The sidebar will never switch away from the File Explorer (or any other panel) on its own. When you manually switch to Express Map, the tree immediately snaps to the route under the current cursor position.

### Broken Reference Detection
Routes that call `res.render('some/view')` where `some/view` doesn't exist in the views directory are flagged:
- Red squiggle on the `res.render()` call
- Entry in the **Problems** panel
- Listed under **Broken References** in the tree

### Potential Issues
Async route handlers that have no `try/catch` block are highlighted with a warning — unhandled rejections crash the server in Node.js.

The warning is suppressed automatically where the errors are already handled: on Express 5, in projects with `express-async-errors` or `express-async-handler` installed, and for handlers wrapped in a helper such as `asyncHandler(...)` or `catchAsync(...)`.

### Wrapped Handlers
`app.get('/x', asyncHandler(async (req, res) => …))` is read through the wrapper, so the route is correctly reported as async and its `res.render()` calls are found even when the response parameter isn't named `res`. Any single-argument wrapper works — the shape is what's recognised, not a list of names.

### Orphaned Templates
Template files that are never referenced by any `res.render()` call appear under **Orphaned Templates**.

### Duplicate Routes
Multiple handlers registered for the same `METHOD /path` combination are grouped under **Duplicate Routes**.

### Multi-Project / Monorepo Support
Express Map works whether you open a single Express project, a multi-root VS Code workspace, or a parent directory containing several Express apps. All Express projects found are analysed and each project becomes a top-level folder in the tree. Every section — Routes, Templates, Middleware, Catch-all Handlers, Orphaned Templates, Duplicate Routes, Broken References, and Potential Issues — is grouped under its own project:

```
▶ my-api
    Routes          142
      ▶ /users        8 routes
    Templates        34
    Middleware        5
▶ admin-service
    Routes          144
      ▶ /dashboard    6 routes
    Templates        28
    Middleware        3
```

Single-project windows show the existing flat layout unchanged.

### Route Grouping
Click the **$(list-filter) grouping icon** in the panel header to cycle between three route-grouping modes:

| Mode | Groups routes by… |
|------|-------------------|
| **By Prefix** *(default)* | first path segment (`/users`, `/admin`, …) |
| **By File** | source file where the route is defined |
| **By Method** | HTTP method (GET, POST, PUT, PATCH, DELETE, …) |

Example — **By File**:
```
▶ Routes  12
    ▶ routes/users.js   4 routes
        GET  /users
        POST /users
        GET  /users/:id
        DEL  /users/:id
    ▶ routes/admin.js   8 routes
        …
```

Example — **By Method**:
```
▶ Routes  12
    ▶ GET    6 routes
    ▶ POST   3 routes
    ▶ DELETE 3 routes
```

The selected mode is saved and restored across VS Code sessions.

### Route Search
Press **Cmd+Shift+F** (macOS) / **Ctrl+Shift+F** (Windows/Linux) with the Express Map panel focused, or click the **$(search) search icon** in the panel header, to open a fuzzy Quick Pick over all routes. You can search by:
- HTTP method (`GET`, `POST`, …)
- Route path (`/admin/users`)
- Source file path (`routes/users.js`)
- Rendered template name (`admin/users`)

Selecting a result opens the source file at the route definition and reveals it in the tree.

### Copilot Integration
Express Map registers a **Copilot language model tool** that gives the AI a structured understanding of your entire Express app — routes, templates, broken refs, async issues, duplicates, and orphans — without you having to describe any of it manually.

**Privacy-first by design.** The tool only runs when you explicitly reference it in a Copilot Chat message:

```
@workspace #express-map_analyzeApp what routes are missing error handling?
```

It will **never** send your app's data to the model automatically or in the background. Your route paths, file structure, and template names stay local until you choose to share them with the AI.

**What it sends when invoked:**
- All route methods and resolved paths (e.g. `GET /admin/payments`)
- Source file paths (relative) and line numbers
- Template names referenced by each route
- Async and error-handling flags per route
- Broken template references, duplicate routes, orphaned templates
- Express version and async-safety status

**What it never sends:** source code content, environment variables, secrets, or any runtime data.

---

## Supported Template Engines

EJS, Pug/Jade, Handlebars/HBS, Mustache, Nunjucks, Twig, Liquid, Eta. Unknown engines are detected automatically by inspecting the views directory.

---

## Requirements

- VS Code 1.118 or later
- An Express.js project with a `package.json` in the workspace root (or any immediate sub-directory for multi-project windows)
- Entry point discovered via `package.json` `"main"` field, or one of: `app.js`, `server.js`, `index.js`
- **Express 4 or 5** — both fully supported

No configuration is needed. Express Map discovers your app's entry point, views directory, and template engine automatically via `app.set()` calls.

---

## Express Version Compatibility

| Feature | Express 4 | Express 5 |
|---|---|---|
| Route tree, CodeLens, template links | ✓ | ✓ |
| `{:param}` optional params (path-to-regexp v8) | — | ✓ |
| `{*name}` named wildcards | — | ✓ |
| Array mount paths `app.use(['/a', '/b'], fn)` | — | ✓ |
| Async errors caught by framework | No — warnings shown | Yes — warnings suppressed |

The detected Express version is shown in the status bar tooltip. If you are on Express 4 and want to suppress the async-without-try/catch warnings, install `express-async-errors`, wrap your handlers in a helper like `asyncHandler(...)`, upgrade to Express 5, or set `expressMap.diagnostics.asyncErrorHandling.severity` to `off`.

---

## Extension Settings

Express Map still needs no configuration — the entry point, views directory and template engine are all discovered from your app, and every setting below defaults to the behaviour you get without touching it. These are escape hatches, not setup.

| Setting | Default | What it does |
|---|---|---|
| `expressMap.diagnostics.brokenTemplateRef.severity` | `error` | Severity for `res.render()` naming a template that isn't in the views directory |
| `expressMap.diagnostics.asyncErrorHandling.severity` | `warning` | Severity for async handlers with no `try`/`catch` |
| `expressMap.excludeDirs` | `[]` | Extra directory names to skip when scanning for templates |

Both severity settings accept `error`, `warning`, `information`, `hint`, or `off`. **`hint` is usually better than `off`** — it keeps the underline in the editor while adding nothing to the Problems panel.

Severities are read per folder, so a multi-root workspace can turn a check off for one project and keep it in the others.

**The tree is unaffected by the severity settings.** Turning a diagnostic off removes it from the Problems panel and the editor; **Broken References** and **Potential Issues** still list everything found. The panel is somewhere you go to look rather than something that interrupts you.

**When you'd turn each one down:**

- **`brokenTemplateRef`** — apps that register view directories at runtime, or render templates produced by a build step, where the file is genuinely absent from the source tree and genuinely present when the app runs.
- **`asyncErrorHandling`** — already suppressed automatically for Express 5, for projects with `express-async-errors` or `express-async-handler` in their dependencies, and for handlers wrapped in a helper like `asyncHandler(...)`. Turn it down if your error handling takes a form Express Map can't see.

**`expressMap.excludeDirs`** takes directory *names*, not globs — a name listed here is skipped wherever it appears in the walk. `node_modules`, `.git` and `out` are always skipped. The usual reason to add to it is a build step that copies compiled templates into the views tree, which otherwise shows up as duplicate and orphaned templates:

```jsonc
{
  "expressMap.excludeDirs": ["dist", "build"]
}
```

---

## How It Works

Express Map uses Babel's parser to perform static AST analysis — it reads your source files but never executes them. It:

1. Finds your Express entry point via `package.json#main` or common filenames
2. Follows `require()` / `import` statements to discover sub-routers
3. Detects `app.set('views', ...)` and `app.set('view engine', ...)` calls
4. Records every `app.get/post/put/patch/delete/use(...)` call with its full path prefix stack
5. Scans the views directory for template files and cross-references them with `res.render()` calls

---

## Known Limitations

- **Dynamic route paths**: Template literals like `` `/${section}/page` `` are converted to `/:section/page`; fully dynamic paths (variables, computed expressions) appear as `[varName]`
- **Dynamic render calls**: `res.render(view)` where `view` is a variable can't be statically resolved (the render ref is collected via object property scanning as a best-effort)
- **Re-exported routers**: Routers exported through index files with re-exports may not always be followed
- **Array-mounted sub-routers**: `app.use(['/a', '/b'], router)` — the router is analysed once per mount path for route listing, but because file analysis is deduplicated, only the first path is used when routes inside share the same file. The first path wins.
- **No runtime analysis**: Middleware conditionally registered at runtime won't be detected

---

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for the full history.

---

## License

MIT — see [LICENSE](LICENSE)
