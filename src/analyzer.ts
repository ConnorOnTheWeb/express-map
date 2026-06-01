import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@babel/parser';
import type { ParserPlugin } from '@babel/parser';
import traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type {
  Node,
  ArrayExpression,
  CallExpression,
  Expression,
  Identifier,
  MemberExpression,
  StringLiteral,
  TemplateLiteral,
  VariableDeclarator,
  ImportDeclaration,
  ImportSpecifier,
  ExpressionStatement,
  ObjectProperty,
  PatternLike,
  RestElement,
} from '@babel/types';
import type { ExpressApp, Route, MiddlewareEntry, Template, OrphanedTemplate, RouteRef, BrokenRef } from './types';

// ─── constants ───────────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const ENTRY_FALLBACKS = ['app.js', 'server.js', 'index.js'];
const RESPONSE_METHODS = new Set<Route['responseType']>(['render', 'json', 'send', 'redirect', 'download']);

// ─── low-level AST helpers ───────────────────────────────────────────────────

function getStringValue(node: Node | null | undefined): string | null {
  if (!node) { return null; }
  if (node.type === 'StringLiteral') { return (node as StringLiteral).value; }
  if (node.type === 'TemplateLiteral') {
    const tl = node as TemplateLiteral;
    if (tl.expressions.length === 0 && tl.quasis.length === 1) {
      return tl.quasis[0].value.cooked ?? null;
    }
  }
  return null;
}

/**
 * Like getStringValue, but also converts template literals whose expressions
 * are simple identifiers into Express-style parameterised paths.
 * e.g. `/${platform}/distance` → '/:platform/distance'
 */
function getRoutePathValue(node: Node | null | undefined): string | null {
  if (!node) { return null; }
  const simple = getStringValue(node);
  if (simple !== null) { return simple; }
  if (node.type === 'TemplateLiteral') {
    const tl = node as TemplateLiteral;
    let result = '';
    for (let i = 0; i < tl.quasis.length; i++) {
      result += tl.quasis[i].value.cooked ?? '';
      if (i < tl.expressions.length) {
        const name = getIdentifierName(tl.expressions[i] as Node);
        result += name ? `:${name}` : ':param';
      }
    }
    return result || null;
  }
  // Plain identifier: router.get(pathVar, handler) — dynamic, use [varName] placeholder
  if (node.type === 'Identifier') {
    return `[${(node as Identifier).name}]`;
  }
  return null;
}

function getIdentifierName(node: Node | null | undefined): string | null {
  if (!node || node.type !== 'Identifier') { return null; }
  return (node as Identifier).name;
}

/** Returns the argument string if node is `require('...')`, else null. */
function getRequireArg(node: Node): string | null {
  if (node.type !== 'CallExpression') { return null; }
  const call = node as CallExpression;
  if (getIdentifierName(call.callee) !== 'require') { return null; }
  if (call.arguments.length !== 1) { return null; }
  const arg = call.arguments[0];
  if (arg.type === 'SpreadElement') { return null; }
  return getStringValue(arg);
}

/** Returns `{ obj, method }` if node is `obj.method(...)`, else null. */
function getMemberCallInfo(node: Node): { obj: string; method: string; call: CallExpression } | null {
  if (node.type !== 'CallExpression') { return null; }
  const call = node as CallExpression;
  if (call.callee.type !== 'MemberExpression') { return null; }
  const mem = call.callee as MemberExpression;
  if (mem.computed) { return null; }
  const obj = getIdentifierName(mem.object);
  const method = getIdentifierName(mem.property);
  if (!obj || !method) { return null; }
  return { obj, method, call };
}

function isExpressCall(node: Node, expressVarNames: Set<string>): boolean {
  if (node.type !== 'CallExpression') { return false; }
  const name = getIdentifierName((node as CallExpression).callee);
  return name !== null && expressVarNames.has(name);
}

function isExpressRouterCall(node: Node, expressVarNames: Set<string>): boolean {
  if (node.type !== 'CallExpression') { return false; }
  const callee = (node as CallExpression).callee;
  if (callee.type !== 'MemberExpression') { return false; }
  const mem = callee as MemberExpression;
  if (mem.computed || getIdentifierName(mem.property) !== 'Router') { return false; }
  const objName = getIdentifierName(mem.object);
  if (objName && expressVarNames.has(objName)) { return true; }
  // require('express').Router()
  if (getRequireArg(mem.object) === 'express') { return true; }
  return false;
}

function isFunctionLike(node: Node): boolean {
  return node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';
}

function isAsyncNode(node: Node): boolean {
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    return (node as { async: boolean }).async;
  }
  return false;
}

/**
 * Returns true if the handler contains any TryStatement anywhere in its body.
 * For non-function handlers (identifier references etc.) we conservatively return true
 * to avoid false positives.
 */
function handlerHasTryCatch(handlerNode: Node): boolean {
  if (!isFunctionLike(handlerNode)) { return true; }
  const body = (handlerNode as { body?: Node }).body;
  if (!body || body.type !== 'BlockStatement') { return true; }

  function hasTry(n: Node, depth = 0): boolean {
    if (depth > 25) { return false; }
    if (n.type === 'TryStatement') { return true; }
    const rec = n as unknown as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key === 'type') { continue; }
      const val = rec[key];
      if (!val || typeof val !== 'object') { continue; }
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === 'object' && (item as Record<string, unknown>)['type']) {
            if (hasTry(item as Node, depth + 1)) { return true; }
          }
        }
      } else if ((val as Record<string, unknown>)['type']) {
        if (hasTry(val as Node, depth + 1)) { return true; }
      }
    }
    return false;
  }

  return hasTry(body);
}

function getFunctionName(node: Node): string | undefined {
  if (node.type === 'FunctionExpression') {
    return (node as { id?: { name: string } | null }).id?.name;
  }
  if (node.type === 'Identifier') { return (node as Identifier).name; }
  return undefined;
}

/**
 * Returns a descriptive name for anonymous catch-all handlers registered via
 * app.use() with no path (or '/').
 *   - 4-param signature (err, req, res, next) → 'error handler'
 *   - Inline call to res.status(404) or res.sendStatus(404) → '404 handler'
 *   - Inline call to res.status(5xx) or res.sendStatus(5xx) → '5xx handler'
 *   - Otherwise → 'catch-all handler'
 */
function inferCatchAllName(node: Node): string {
  const params: Array<Node | PatternLike | RestElement> =
    (node as { params?: Array<Node | PatternLike | RestElement> }).params ?? [];
  if (params.length === 4) { return 'error handler'; }

  // Scan the function body for a numeric status code passed to res.status() / res.sendStatus()
  const body = (node as { body?: Node }).body;
  if (body) {
    let statusCode: number | undefined;
    const scan = (n: Node | null | undefined): void => {
      if (!n || typeof n !== 'object') { return; }
      if (
        n.type === 'CallExpression' &&
        (n as CallExpression).callee.type === 'MemberExpression'
      ) {
        const callee = (n as CallExpression).callee as MemberExpression;
        const prop = callee.property;
        const propName = prop.type === 'Identifier' ? (prop as Identifier).name : '';
        if (propName === 'status' || propName === 'sendStatus') {
          const firstArg = (n as CallExpression).arguments[0];
          if (firstArg?.type === 'NumericLiteral') {
            statusCode = (firstArg as { value: number }).value;
          }
        }
      }
      for (const key of Object.keys(n)) {
        const child = (n as unknown as Record<string, unknown>)[key];
        if (Array.isArray(child)) {
          for (const item of child) {
            if (item && typeof item === 'object' && 'type' in item) { scan(item as Node); }
          }
        } else if (child && typeof child === 'object' && 'type' in child) {
          scan(child as Node);
        }
      }
    };
    scan(body);
    if (statusCode !== undefined) {
      if (statusCode >= 400 && statusCode < 500) { return `${statusCode} handler`; }
      if (statusCode >= 500 && statusCode < 600) { return `${statusCode} handler`; }
    }
  }

  return 'catch-all handler';
}

function getResParamName(handler: Node): string {
  const params: Array<Node | PatternLike | RestElement> =
    (handler as { params?: Array<Node | PatternLike | RestElement> }).params ?? [];
  // 4-param signature = Express error handler: (err, req, res, next)
  if (params.length === 4) { return getIdentifierName(params[2] as Node) ?? 'res'; }
  if (params.length >= 2) { return getIdentifierName(params[1] as Node) ?? 'res'; }
  return 'res';
}

function extractPathParams(routePath: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  // Express 4 + 5: :name named parameter
  for (const m of routePath.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); result.push(m[1]); }
  }
  // Express 5 path-to-regexp v8:
  //   {:name}  — optional named parameter
  //   {*name}  — named wildcard
  //   {name}   — unnamed optional group (no useful param name, skip)
  for (const m of routePath.matchAll(/\{[*:]([a-zA-Z_][a-zA-Z0-9_]*)\}/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); result.push(m[1]); }
  }
  return result;
}

function joinPaths(...parts: string[]): string {
  const joined = parts
    .filter(p => p && p !== '/')
    .map(p => p.replace(/\/+$/, ''))
    .join('');
  return joined || '/';
}

// ─── response-type detection ─────────────────────────────────────────────────

interface ResponseResult {
  type: Route['responseType'];
  templateName?: string;
  templatePrefix?: string;
  /** All additional template names found in the same handler (multiple code paths). */
  extraTemplateRefs: string[];
  extraTemplatePrefixes: string[];
}

/**
 * Recursively walk an AST subtree collecting ALL `res.METHOD()` calls.
 *
 * Two bugs in the naive "first wins" approach are fixed here:
 *  1. Chained calls (`res.status(404).render(...)`) — handled by checking the
 *     root of the method chain rather than requiring a bare Identifier object.
 *  2. Redirect/error guards before the happy-path render — handled by a
 *     "last render wins" heuristic: Express handlers typically end with the
 *     main render after early-return guards at the top.
 *
 * primaryType     = first response method seen (determines the route's responseType badge).
 * primaryTemplate = LAST res.render() template found (happy-path render).
 * extraTemplateRefs = all earlier render template names (fallback / error paths).
 */
function detectResponse(handlerNode: Node, resName: string): ResponseResult {
  let primaryType: Route['responseType'] = 'unknown';
  let foundPrimary = false;
  // Collect every render call in source order; last entry = happy-path template.
  const allRenders: Array<{ name: string | undefined; prefix: string | undefined }> = [];

  /** True if `obj` is `resName` or a method chain rooted at it, e.g. res.status(400). */
  function rootIsRes(obj: Record<string, unknown>): boolean {
    if (obj['type'] === 'Identifier') { return obj['name'] === resName; }
    if (obj['type'] === 'CallExpression') {
      const cal = obj['callee'] as Record<string, unknown> | undefined;
      if (cal?.['type'] === 'MemberExpression') {
        return rootIsRes(cal['object'] as Record<string, unknown>);
      }
    }
    return false;
  }

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') { return; }
    const n = node as Record<string, unknown>;
    if (typeof n['type'] !== 'string') { return; }

    if (n['type'] === 'CallExpression') {
      const callee = n['callee'] as Record<string, unknown> | undefined;
      if (callee?.['type'] === 'MemberExpression' && !callee['computed']) {
        const obj = callee['object'] as Record<string, unknown> | undefined;
        const prop = callee['property'] as Record<string, unknown> | undefined;
        if (
          obj !== undefined &&
          rootIsRes(obj) &&
          prop?.['type'] === 'Identifier' &&
          typeof prop['name'] === 'string'
        ) {
          const methodName = prop['name'] as Route['responseType'];
          if (RESPONSE_METHODS.has(methodName)) {
            if (!foundPrimary) { primaryType = methodName; foundPrimary = true; }
            if (methodName === 'render') {
              let tplName: string | undefined;
              let tplPrefix: string | undefined;
              const args = n['arguments'] as unknown[] | undefined;
              if (args && args.length > 0) {
                const renderArg = args[0] as Node;
                tplName = getStringValue(renderArg) ?? undefined;
                if (tplName === undefined && renderArg?.type === 'TemplateLiteral') {
                  const tl = renderArg as TemplateLiteral;
                  if (tl.expressions.length > 0 && tl.quasis.length > 0) {
                    const prefix = tl.quasis[0].value.cooked ?? '';
                    if (prefix) { tplPrefix = prefix; }
                  }
                }
              }
              allRenders.push({ name: tplName, prefix: tplPrefix });
            }
            // Continue walking — don't stop; handler may have multiple render paths
          }
        }
      }
    }

    for (const key of Object.keys(n)) {
      if (key === 'type') { continue; }
      const val = n[key];
      if (!val || typeof val !== 'object') { continue; }
      if (Array.isArray(val)) {
        for (const item of val) { walk(item); }
      } else if ((val as Record<string, unknown>)['type']) {
        walk(val);
      }
    }
  }

  walk(handlerNode);

  // Last render in source order = happy-path template; earlier ones = fallback/error renders.
  const lastRender = allRenders[allRenders.length - 1];
  const primaryTemplate = lastRender?.name;
  const primaryPrefix = lastRender?.prefix;
  const extraRefs = allRenders.slice(0, -1).map(r => r.name).filter((s): s is string => s !== undefined);
  const extraPrefixes = allRenders.slice(0, -1).map(r => r.prefix).filter((s): s is string => s !== undefined);

  return { type: primaryType, templateName: primaryTemplate, templatePrefix: primaryPrefix, extraTemplateRefs: extraRefs, extraTemplatePrefixes: extraPrefixes };
}

// ─── file system helpers ──────────────────────────────────────────────────────

function readFileSafe(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf-8'); }
  catch { return null; }
}

function tryAccess(p: string): boolean {
  try { fs.accessSync(p); return true; }
  catch { return false; }
}

function resolveRequirePath(fromDir: string, req: string): string | null {
  if (!req.startsWith('.')) { return null; }
  const base = path.resolve(fromDir, req);
  const exts = ['.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx'];
  for (const ext of ['', ...exts]) {
    if (tryAccess(base + ext)) { return base + ext; }
  }
  for (const ext of exts) {
    const idx = path.join(base, `index${ext}`);
    if (tryAccess(idx)) { return idx; }
  }
  return null;
}

/** Reused plugin arrays — avoids a new allocation on every parseCode call. */
const TS_PLUGINS: ParserPlugin[] = ['typescript'];

function parseCode(filePath: string, code: string): ReturnType<typeof parse> | null {
  try {
    return parse(code, {
      sourceType: 'unambiguous',
      plugins: (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) ? TS_PLUGINS : [],
      errorRecovery: true,
    });
  } catch {
    return null;
  }
}

// ─── entry-point discovery ────────────────────────────────────────────────────

function findEntryPoint(workspaceRoot: string): string | null {
  const pkgPath = path.join(workspaceRoot, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    if (typeof pkg['main'] === 'string') {
      const main = path.resolve(workspaceRoot, pkg['main']);
      if (tryAccess(main)) { return main; }
      for (const ext of ['.js', '.ts']) {
        if (tryAccess(main + ext)) { return main + ext; }
      }
    }
  } catch { /* fall through */ }

  for (const fallback of ENTRY_FALLBACKS) {
    const p = path.join(workspaceRoot, fallback);
    if (tryAccess(p)) { return p; }
  }
  return null;
}

// ─── analysis state ───────────────────────────────────────────────────────────

interface AnalysisState {
  routes: Route[];
  middleware: MiddlewareEntry[];
  templateRefs: Set<string>;
  templateRefPrefixes: Set<string>;
  /** All JS/TS files analysed — scanned file-wide for any res.render() after route analysis. */
  analysedFiles: Set<string>;
  viewsDir: string | null;
  viewEngine: string | null;  // value of app.set('view engine', ...)
  entryDir: string;
  /** Source text of each analysed file — reused in the file-wide render scan; avoids re-reading disk. */
  codeCache: Map<string, string>;
  /** Parsed AST of each analysed file — reused in the file-wide render scan; avoids re-parsing. */
  astCache: Map<string, ReturnType<typeof parse>>;
  /** Memoised resolveRequirePath results for this run, keyed by `fromDir\0req`. */
  resolveCache: Map<string, string | null>;
}

// ─── per-file analysis ────────────────────────────────────────────────────────

async function analyzeFile(
  filePath: string,
  prefixStack: string[],
  isRoot: boolean,
  visited: Set<string>,
  state: AnalysisState,
): Promise<void> {
  if (visited.has(filePath)) { return; }
  visited.add(filePath);
  state.analysedFiles.add(filePath);

  const code = readFileSafe(filePath);
  if (!code) { return; }
  state.codeCache.set(filePath, code);

  const ast = parseCode(filePath, code);
  if (!ast) { return; }
  state.astCache.set(filePath, ast);

  const dir = path.dirname(filePath);

  // Memoised require resolver — collapses up to 14 fs.accessSync calls per repeated require into one.
  const cachedResolve = (fromDir: string, req: string): string | null => {
    const key = `${fromDir}\0${req}`;
    const hit = state.resolveCache.get(key);
    if (hit !== undefined) { return hit; }
    const resolved = resolveRequirePath(fromDir, req);
    state.resolveCache.set(key, resolved);
    return resolved;
  };

  const expressVarNames = new Set<string>();
  const routerFactoryNames = new Set<string>(); // named Router imports: import { Router } from 'express'
  const requireMap = new Map<string, string>(); // varName → resolvedFilePath

  // ── Pass 1: collect variable bindings ──────────────────────────────────────
  traverse(ast, {
    ImportDeclaration(nodePath: NodePath<ImportDeclaration>) {
      const source = nodePath.node.source.value;

      if (source === 'express') {
        // import express from 'express' / import * as express / import { Router }
        for (const spec of nodePath.node.specifiers) {
          if (
            spec.type === 'ImportDefaultSpecifier' ||
            spec.type === 'ImportNamespaceSpecifier'
          ) {
            expressVarNames.add(spec.local.name);
          } else if (spec.type === 'ImportSpecifier') {
            const importedName =
              (spec as ImportSpecifier).imported.type === 'Identifier'
                ? ((spec as ImportSpecifier).imported as Identifier).name
                : ((spec as ImportSpecifier).imported as { value: string }).value;
            if (importedName === 'Router') {
              routerFactoryNames.add(spec.local.name);
            }
          }
        }
        return;
      }

      // Relative import  →  populate requireMap so sub-routers are followed
      if (source.startsWith('.')) {
        const resolved = cachedResolve(dir, source);
        if (!resolved) { return; }
        for (const spec of nodePath.node.specifiers) {
          if (
            spec.type === 'ImportDefaultSpecifier' ||
            spec.type === 'ImportNamespaceSpecifier'
          ) {
            requireMap.set(spec.local.name, resolved);
          }
        }
      }
    },

    VariableDeclarator(nodePath: NodePath<VariableDeclarator>) {
      const { id, init } = nodePath.node;
      if (id.type !== 'Identifier' || !init) { return; }
      const varName = (id as Identifier).name;

      const reqArg = getRequireArg(init);
      if (reqArg !== null) {
        if (reqArg === 'express') {
          expressVarNames.add(varName);
        } else {
          const resolved = cachedResolve(dir, reqArg);
          if (resolved) { requireMap.set(varName, resolved); }
        }
        return;
      }

      if (isExpressCall(init, expressVarNames)) {
        expressVarNames.add(varName);
        return;
      }

      if (isExpressRouterCall(init, expressVarNames)) {
        expressVarNames.add(varName);
        return;
      }

      // const router = Router()  — named import of Router from express
      if (
        init.type === 'CallExpression' &&
        (init as CallExpression).callee.type === 'Identifier'
      ) {
        const calleeName = getIdentifierName((init as CallExpression).callee);
        if (calleeName && routerFactoryNames.has(calleeName)) {
          expressVarNames.add(varName);
        }
      }
    },
  });

  // ── Pass 2: extract routes and middleware ──────────────────────────────────
  const pendingSubRouters: Array<{ filePath: string; prefix: string[] }> = [];

  traverse(ast, {
    ExpressionStatement(nodePath: NodePath<ExpressionStatement>) {
      const expr = nodePath.node.expression;
      const info = getMemberCallInfo(expr);
      if (!info) { return; }
      const { obj, method, call } = info;
      if (!expressVarNames.has(obj)) { return; }

      // app.set('views', ...) or app.set('view engine', ...)
      if (isRoot && method === 'set' && call.arguments.length >= 2) {
        const key = getStringValue(call.arguments[0] as Node);
        if (key === 'views') {
          const viewsArg = call.arguments[1];
          if (viewsArg.type !== 'SpreadElement') {
            const strVal = getStringValue(viewsArg as Node);
            if (strVal) {
              state.viewsDir = path.isAbsolute(strVal)
                ? strVal
                : path.resolve(dir, strVal);
            }
          }
        } else if (key === 'view engine') {
          const engArg = call.arguments[1];
          if (engArg.type !== 'SpreadElement') {
            const eng = getStringValue(engArg as Node);
            if (eng) { state.viewEngine = eng.toLowerCase(); }
          }
        }
        return;
      }

      // HTTP route registration: app.get('/path', ...middleware, handler)
      // Express 4+5: first arg may be a string, template literal, identifier, or an array of paths.
      if (HTTP_METHODS.has(method)) {
        if (call.arguments.length < 2) { return; }
        const firstArg = call.arguments[0];
        if (firstArg.type === 'SpreadElement') { return; }

        // Resolve the raw path(s). An array of paths registers the same handler at multiple paths.
        const rawPaths: string[] = firstArg.type === 'ArrayExpression'
          ? (firstArg as ArrayExpression).elements
              .filter((el): el is Expression => el !== null && el.type !== 'SpreadElement')
              .map(el => getRoutePathValue(el as Node))
              .filter((p): p is string => p !== null)
          : [getRoutePathValue(firstArg as Node) ?? ''];

        const line: number = call.loc?.start.line ?? 0;
        const args = call.arguments.filter(a => a.type !== 'SpreadElement') as Expression[];

        // all args except path (first) and final handler
        const middlewareArgs = args.slice(1, -1);
        const handlerArg = args[args.length - 1];

        const resName = isFunctionLike(handlerArg) ? getResParamName(handlerArg) : 'res';
        const { type: responseType, templateName, templatePrefix, extraTemplateRefs, extraTemplatePrefixes } = detectResponse(handlerArg, resName);
        if (templateName) { state.templateRefs.add(templateName); }
        if (templatePrefix) { state.templateRefPrefixes.add(templatePrefix); }
        for (const ref of extraTemplateRefs) { state.templateRefs.add(ref); }
        for (const pfx of extraTemplatePrefixes) { state.templateRefPrefixes.add(pfx); }

        const routeMiddleware: MiddlewareEntry[] = middlewareArgs
          .filter(isFunctionLike)
          .map(mArg => ({
            name: getFunctionName(mArg),
            file: filePath,
            line: mArg.loc?.start.line ?? 0,
            scope: 'route' as const,
          }));

        const methodLabel = method === 'all' ? 'ALL' : method.toUpperCase();
        const isAsync = isFunctionLike(handlerArg) ? isAsyncNode(handlerArg) : false;
        const hasTryCatch = handlerHasTryCatch(handlerArg);

        // Register one route entry per path (array paths mount the same handler at multiple URLs)
        for (const rawPath of rawPaths) {
          const resolvedPath = joinPaths(...prefixStack, rawPath);
          const route: Route = {
            method: methodLabel,
            path: rawPath,
            resolvedPath,
            file: filePath,
            line,
            isAsync,
            hasTryCatch,
            params: extractPathParams(resolvedPath),
            responseType,
            templateName,
            extraTemplateRefs,
            middleware: routeMiddleware,
          };
          state.routes.push(route);
        }
        state.middleware.push(...routeMiddleware);
        return;
      }

      // app.use(...) — middleware or sub-router mounting
      // Express 4+5: first arg may be a string path or an array of paths.
      if (method === 'use') {
        const args = call.arguments.filter(a => a.type !== 'SpreadElement') as Expression[];
        if (args.length === 0) { return; }

        // Resolve mount path(s) — support array syntax: app.use(['/api', '/v1'], router)
        let mountPaths: string[] = ['/'];
        let handlerArgs: Expression[] = args;
        if (getStringValue(args[0]) !== null) {
          mountPaths = [getStringValue(args[0]) ?? '/'];
          handlerArgs = args.slice(1);
        } else if (args[0].type === 'ArrayExpression') {
          const ae = args[0] as ArrayExpression;
          const strings = ae.elements
            .filter((el): el is Expression => el !== null && el.type !== 'SpreadElement')
            .map(el => getStringValue(el as Node))
            .filter((s): s is string => s !== null);
          if (strings.length > 0) { mountPaths = strings; }
          handlerArgs = args.slice(1);
        }
        const isGlobal = isRoot && mountPaths.every(p => p === '/');

        for (const mountPath of mountPaths) {
        for (const handlerArg of handlerArgs) {
          // Inline require: app.use('/api', require('./routes'))
          const inlineReq = getRequireArg(handlerArg);
          if (inlineReq !== null && inlineReq.startsWith('.')) {
            const resolved = cachedResolve(dir, inlineReq);
            if (resolved) {
              pendingSubRouters.push({ filePath: resolved, prefix: [...prefixStack, mountPath] });
            }
            continue;
          }

          // Variable reference: app.use('/api', apiRouter)
          const argName = getIdentifierName(handlerArg);
          if (argName && requireMap.has(argName)) {
            pendingSubRouters.push({
              filePath: requireMap.get(argName)!,
              prefix: [...prefixStack, mountPath],
            });
            continue;
          }

          // Middleware function or named reference
          if (isFunctionLike(handlerArg) || argName) {
            const explicitName = getFunctionName(handlerArg);
            // Catch-all: anonymous inline function registered globally (no path mount,
            // or mounted at '/') — these are 404/error handlers, not pipeline middleware.
            const isCatchAll = isGlobal && isFunctionLike(handlerArg) && !explicitName;
            const entry: MiddlewareEntry = {
              name: explicitName ?? (isCatchAll ? inferCatchAllName(handlerArg) : undefined),
              file: filePath,
              line: handlerArg.loc?.start.line ?? 0,
              scope: isGlobal ? 'global' : 'router',
              isCatchAll,
            };
            state.middleware.push(entry);

            // Also scan inline function handlers for res.render() calls
            // (catches 404/error handlers that render templates via app.use())
            if (isFunctionLike(handlerArg)) {
              const resName = getResParamName(handlerArg);
              const { templateName, templatePrefix, extraTemplateRefs, extraTemplatePrefixes } =
                detectResponse(handlerArg, resName);
              if (templateName) { state.templateRefs.add(templateName); }
              if (templatePrefix) { state.templateRefPrefixes.add(templatePrefix); }
              for (const ref of extraTemplateRefs) { state.templateRefs.add(ref); }
              for (const pfx of extraTemplatePrefixes) { state.templateRefPrefixes.add(pfx); }
            }
          }
        }
        } // end mountPaths loop
      }
    },
  });

  // Recurse into discovered sub-routers after both traversals complete
  for (const pending of pendingSubRouters) {
    await analyzeFile(pending.filePath, pending.prefix, false, visited, state);
  }
}

// ─── template scanning ────────────────────────────────────────────────────────

/**
 * Maps a view-engine name (as passed to app.set('view engine', ...)) to the
 * file extension(s) it uses.  Keys are lower-cased engine names.
 */
const ENGINE_EXTENSIONS: Record<string, string[]> = {
  ejs:        ['.ejs'],
  pug:        ['.pug'],
  jade:       ['.jade'],          // legacy alias for pug
  hbs:        ['.hbs', '.handlebars'],
  handlebars: ['.hbs', '.handlebars'],
  mustache:   ['.mustache'],
  nunjucks:   ['.njk', '.html'],
  njk:        ['.njk', '.html'],
  twig:       ['.twig'],
  liquid:     ['.liquid'],
  eta:        ['.eta'],
};

/** All template extensions we'll consider when probing an unknown engine. */
const ALL_TEMPLATE_EXTS = new Set(
  Object.values(ENGINE_EXTENSIONS).flat(),
);

/**
 * Resolve which file extensions to look for, given an optional declared engine name.
 * If the engine is unknown or not declared, probes the views directory to see
 * which extension(s) actually appear there and picks the most common ones.
 */
function resolveTemplateExtensions(viewsDir: string, viewEngine: string | null): string[] {
  if (viewEngine) {
    const exts = ENGINE_EXTENSIONS[viewEngine];
    if (exts) { return exts; }
  }

  // Probe: count files by extension inside the views dir
  const counts = new Map<string, number>();
  function probe(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && !['node_modules', '.git', 'out'].includes(entry.name)) {
        probe(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ALL_TEMPLATE_EXTS.has(ext)) {
          counts.set(ext, (counts.get(ext) ?? 0) + 1);
        }
      }
    }
  }
  probe(viewsDir);

  if (counts.size === 0) { return ['.ejs']; } // safe fallback
  // Return all extensions that appear, sorted by frequency descending
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ext]) => ext);
}

function findTemplateFiles(dir: string, extensions: string[]): string[] {
  const extSet = new Set(extensions);
  const results: string[] = [];

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'out'].includes(entry.name)) { walk(full); }
      } else if (entry.isFile() && extSet.has(path.extname(entry.name).toLowerCase())) {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Reads the workspace's package.json to determine:
 * - The installed Express version (semver string, or '' if not found)
 * - Whether async errors are automatically caught at the framework level, which
 *   means "async handler without try/catch" is NOT a real issue:
 *     • Express 5+ catches rejected promises from route handlers automatically
 *     • express-async-errors patches Express 4 to do the same
 *     • express-async-handler is a wrapper that swallows unhandled rejections
 */
function detectExpressSetup(workspaceRoot: string): { expressVersion: string; asyncErrorsSafe: boolean } {
  try {
    const pkgPath = path.join(workspaceRoot, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const deps: Record<string, string> = {
      ...((pkg['dependencies'] as Record<string, string>) ?? {}),
      ...((pkg['devDependencies'] as Record<string, string>) ?? {}),
    };

    const hasAsyncPatch =
      'express-async-errors' in deps || 'express-async-handler' in deps;

    const rawVersion = deps['express'] ?? '';
    // Strip semver range prefixes (^, ~, >=, etc.) to get the bare version string
    const expressVersion = rawVersion.replace(/^[^0-9]*/, '');
    const majorStr = expressVersion.match(/^(\d+)/)?.[1] ?? '4';
    const major = parseInt(majorStr, 10);

    return {
      expressVersion,
      asyncErrorsSafe: major >= 5 || hasAsyncPatch,
    };
  } catch {
    return { expressVersion: '', asyncErrorsSafe: false };
  }
}

// ─── multi-root helpers ───────────────────────────────────────────────────────

function hasExpressDependency(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as Record<string, unknown>;
    const deps = {
      ...((pkg['dependencies'] as Record<string, unknown>) ?? {}),
      ...((pkg['devDependencies'] as Record<string, unknown>) ?? {}),
    };
    return 'express' in deps;
  } catch {
    return false;
  }
}

/**
 * Returns the Express project roots reachable from `workspaceRoot`.
 * If the root itself lists express as a dependency, returns `[workspaceRoot]`.
 * Otherwise scans one level of sub-directories for folders that do — this
 * covers the common case of opening a parent directory that contains several
 * Express apps (e.g. a monorepo or a `/projects/` folder).
 */
export function findExpressRoots(workspaceRoot: string): string[] {
  if (hasExpressDependency(workspaceRoot)) {
    return [workspaceRoot];
  }
  const roots: string[] = [];
  try {
    const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
      const subdir = path.join(workspaceRoot, entry.name);
      if (hasExpressDependency(subdir)) { roots.push(subdir); }
    }
  } catch { /* directory not readable */ }
  return roots;
}

/**
 * Merges multiple per-root `ExpressApp` results into one combined result.
 * Duplicate-route detection is preserved per-project so routes that share the
 * same path across different apps are NOT incorrectly flagged as duplicates.
 */
export function mergeExpressApps(apps: ExpressApp[]): ExpressApp {
  if (apps.length === 0) {
    return {
      routes: [], middleware: [], templates: [], orphanedTemplates: [],
      duplicateRoutes: [], brokenRefs: [], viewsDir: '', viewEngine: '',
      expressVersion: '', asyncErrorsSafe: false,
    };
  }
  if (apps.length === 1) { return apps[0]; }
  return {
    routes:           apps.flatMap(a => a.routes),
    middleware:       apps.flatMap(a => a.middleware),
    templates:        apps.flatMap(a => a.templates),
    orphanedTemplates: apps.flatMap(a => a.orphanedTemplates),
    duplicateRoutes:  apps.flatMap(a => a.duplicateRoutes),
    brokenRefs:       apps.flatMap(a => a.brokenRefs),
    viewsDir:         apps.find(a => a.viewsDir)?.viewsDir ?? '',
    viewEngine:       apps.find(a => a.viewEngine)?.viewEngine ?? '',
    expressVersion:   apps.find(a => a.expressVersion)?.expressVersion ?? '',
    // Conservative AND: any Express 4 project without an async patch means
    // "async without try/catch" warnings should still be shown for that project.
    asyncErrorsSafe:  apps.every(a => a.asyncErrorsSafe),
  };
}

export async function analyzeWorkspace(workspaceRoot: string): Promise<ExpressApp> {
  const empty: ExpressApp = {
    routes: [],
    middleware: [],
    templates: [],
    orphanedTemplates: [],
    duplicateRoutes: [],
    brokenRefs: [],
    viewsDir: '',
    viewEngine: '',
    expressVersion: '',
    asyncErrorsSafe: false,
  };

  const entryPoint = findEntryPoint(workspaceRoot);
  if (!entryPoint) { return empty; }

  const state: AnalysisState = {
    routes: [],
    middleware: [],
    templateRefs: new Set(),
    templateRefPrefixes: new Set(),
    analysedFiles: new Set(),
    viewsDir: null,
    viewEngine: null,
    entryDir: path.dirname(entryPoint),
    codeCache: new Map(),
    astCache: new Map(),
    resolveCache: new Map(),
  };

  try {
    await analyzeFile(entryPoint, [], true, new Set(), state);
  } catch {
    return empty;
  }

  // Detect express version/async safety early so it can be stamped onto every route.
  // Per-route flags prevent false-positive warnings in multi-project workspaces where
  // one project uses Express 5 and another uses Express 4 without an async-error patch.
  const { expressVersion, asyncErrorsSafe } = detectExpressSetup(workspaceRoot);

  // Tag every route with its project root and async-safety flag.
  for (const r of state.routes) {
    r.projectRoot = workspaceRoot;
    r.asyncErrorsSafe = asyncErrorsSafe;
  }
  // Tag every middleware entry with its project root.
  for (const m of state.middleware) {
    m.projectRoot = workspaceRoot;
  }

  // Resolve views directory and template engine
  const viewsDir = state.viewsDir ?? path.join(state.entryDir, 'views');
  const templateExts = resolveTemplateExtensions(viewsDir, state.viewEngine);
  const viewEngine = state.viewEngine ?? (templateExts[0]?.replace(/^\./,'') ?? 'ejs');
  const templateFiles = findTemplateFiles(viewsDir, templateExts);

  // ── File-wide render scan ─────────────────────────────────────────────────
  // Walk every analysed JS/TS file and collect res.render() calls that were
  // missed by the route-centric analysis (named error handlers, loop-body
  // handlers, variable render args resolved to a string by the caller, etc.).
  // We accept any identifier as the response object name and scan for .render().
  for (const srcFile of state.analysedFiles) {
    // Reuse cached code and AST from analyzeFile — avoids re-reading disk and re-parsing Babel AST.
    const code = state.codeCache.get(srcFile);
    if (!code) { continue; }
    // Quick string pre-filter — skip files with no render calls at all.
    if (!code.includes('.render(')) { continue; }
    const ast = state.astCache.get(srcFile);
    if (!ast) { continue; }
    const renderIdentifiers = new Set<string>();
    traverse(ast, {
      CallExpression(nodePath) {
        const { node } = nodePath;
        if (node.callee.type !== 'MemberExpression') { return; }
        const mem = node.callee as MemberExpression;
        if (mem.computed || getIdentifierName(mem.property) !== 'render') { return; }
        if (node.arguments.length === 0) { return; }
        const firstArg = node.arguments[0];
        if (firstArg.type === 'SpreadElement') { return; }
        const tplName = getStringValue(firstArg as Node);
        if (tplName) {
          state.templateRefs.add(tplName);
          return;
        }
        // Template literal with expressions — grab static prefix
        if (firstArg.type === 'TemplateLiteral') {
          const tl = firstArg as TemplateLiteral;
          if (tl.expressions.length > 0 && tl.quasis.length > 0) {
            const prefix = tl.quasis[0].value.cooked ?? '';
            if (prefix) { state.templateRefPrefixes.add(prefix); }
          }
          return;
        }
        // Identifier: e.g. res.render(view) where view comes from a data array
        const identName = getIdentifierName(firstArg as Node);
        if (identName) { renderIdentifiers.add(identName); }
      },
    });
    // Second pass: for any identifier used as a render arg, find object properties
    // with that name whose values are string literals (e.g. { view: 'static/privacy-policy' })
    if (renderIdentifiers.size > 0) {
      traverse(ast, {
        ObjectProperty(nodePath) {
          const { node } = nodePath as { node: ObjectProperty };
          const keyName =
            node.key.type === 'Identifier'
              ? getIdentifierName(node.key as Node)
              : getStringValue(node.key as Node);
          if (!keyName || !renderIdentifiers.has(keyName)) { return; }
          const val = getStringValue(node.value as Node);
          if (val) { state.templateRefs.add(val); }
        },
      });
    }
  }

  // Precompute inverted index: normalised render ref → routes that use it.
  // Reduces template→route matching from O(T × R × E) to O(R + T).
  const routesByTemplateRef = new Map<string, Route[]>();
  for (const r of state.routes) {
    for (const raw of [r.templateName, ...r.extraTemplateRefs]) {
      if (!raw) { continue; }
      const ref = raw.replace(/\.[a-z]+$/, '').replace(/^\//, '');
      const list = routesByTemplateRef.get(ref);
      if (list) { list.push(r); } else { routesByTemplateRef.set(ref, [r]); }
    }
  }

  // Build templates list with back-references to routes.
  const templates: Template[] = templateFiles.map(file => {
    const ext = path.extname(file);
    const relName = path.relative(viewsDir, file).slice(0, -ext.length).replace(/\\/g, '/');
    // O(1) lookup via inverted index. For root-level templates relName === baseName, so
    // the original baseName fallback was always redundant — relName lookup suffices.
    const usedByRoutes: RouteRef[] = (routesByTemplateRef.get(relName) ?? [])
      .map(r => ({ label: `${r.method} ${r.resolvedPath}`, file: r.file, line: r.line }));
    return { name: relName, file, usedByRoutes, projectRoot: workspaceRoot };
  });

  // Orphaned templates: template files never referenced by res.render().
  // Derived from the already-computed templates array so templateFiles is not
  // iterated a second time with duplicate relName/baseName computation.
  const orphanedTemplates: OrphanedTemplate[] = templates
    .filter(t => {
      const segments = t.name.split('/');
      // Includes/layouts/partials are never directly rendered — skip by convention
      if (segments[0] === 'partials' || segments[0] === 'layouts' || segments[0] === 'includes') { return false; }
      const lastName = segments[segments.length - 1];
      if (lastName.startsWith('_')) { return false; }
      if (state.templateRefs.has(t.name)) { return false; }
      // Only use last-segment matching for root-level templates
      if (!t.name.includes('/') && state.templateRefs.has(lastName)) { return false; }
      // Check prefix-based references (e.g. res.render(`social/${platform}`))
      for (const prefix of state.templateRefPrefixes) {
        if (t.name.startsWith(prefix) || lastName.startsWith(prefix)) { return false; }
      }
      return true;
    })
    .map(t => ({ name: t.name, file: t.file, projectRoot: workspaceRoot }));

  // Duplicate routes: same HTTP method + resolved path
  const routeGroups = new Map<string, Route[]>();
  for (const route of state.routes) {
    const key = `${route.method}:${route.resolvedPath}`;
    const group = routeGroups.get(key);
    if (group) { group.push(route); }
    else { routeGroups.set(key, [route]); }
  }
  const duplicateRoutes = [...routeGroups.values()].filter(g => g.length > 1);

  // Broken template references: res.render() calls whose template name has no matching file
  const templateNames = new Set(templates.map(t => t.name));
  const brokenRefs: BrokenRef[] = state.routes
    .filter(r => r.responseType === 'render' && r.templateName)
    .filter(r => {
      const normalized = (r.templateName ?? '')
        .replace(/\.[a-z]+$/, '')
        .replace(/^\//, '');
      return !templateNames.has(normalized);
    })
    .map(r => ({
      method: r.method,
      resolvedPath: r.resolvedPath,
      templateName: r.templateName!,
      file: r.file,
      line: r.line,
      projectRoot: r.projectRoot,
    }));

  return {
    routes: state.routes,
    middleware: state.middleware,
    templates,
    orphanedTemplates,
    duplicateRoutes,
    brokenRefs,
    viewsDir,
    viewEngine,
    expressVersion,
    asyncErrorsSafe,
  };
}
