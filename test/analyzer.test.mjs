/**
 * analyzer.test.mjs
 *
 * Tests the analyser against a real Express app written to a temp directory
 * and read off disk, which is the only way to exercise it honestly: it finds
 * the entry point, follows requires, walks the views tree and parses with
 * Babel, and none of that is reachable from a hand-built AST.
 *
 * `analyzer.ts` imports no `vscode` API — only `fs`, `path` and Babel — so it
 * runs directly under Node with no extension host and no downloaded VS Code
 * build. `routeChecks.ts` is the same. Both are loaded from the tsc output in
 * `out/`, so `npm run compile` has to have run first; the `test:analyzer`
 * script does that.
 */

import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { analyzeWorkspace } = require('../out/analyzer.js');
const { hasAsyncIssue } = require('../out/routeChecks.js');

// ─── assertions ───────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    passed++;
  } else {
    failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
  const status = ok ? '  ok  ' : ' FAIL ';
  console.log(`${status} ${label.padEnd(62)} ${JSON.stringify(actual)}`);
}

// ─── fixture ──────────────────────────────────────────────────────────────────

const APP_JS = `
const express = require('express');
const app = express();

app.set('view engine', 'ejs');

// Plain async handler with no try/catch — the case the warning is for.
app.get('/bare', async (req, res) => {
  res.render('home');
});

// Async handler wrapped in a helper, with a response parameter that is NOT
// called 'res'. Before wrappers were unwrapped this route was recorded as
// synchronous and its template was never resolved.
app.get('/wrapped', asyncHandler(async (req, reply) => {
  reply.render('dash');
}));

// Async handler that does handle its own errors.
app.get('/guarded', async (req, res) => {
  try {
    res.render('home');
  } catch (err) {
    res.send('nope');
  }
});

// Synchronous handler.
app.get('/sync', (req, res) => {
  res.send('ok');
});

// A wrapper taking more than one argument is not a handler wrapper.
app.get('/multi', withOptions(async (req, res) => { res.send('x'); }, { retries: 2 }));

module.exports = app;
`;

function writeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'express-map-test-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture-app',
      main: 'app.js',
      dependencies: { express: '^4.18.2' },
    }),
  );
  fs.writeFileSync(path.join(root, 'app.js'), APP_JS);

  fs.mkdirSync(path.join(root, 'views'), { recursive: true });
  fs.writeFileSync(path.join(root, 'views', 'home.ejs'), '<p>home</p>');
  fs.writeFileSync(path.join(root, 'views', 'dash.ejs'), '<p>dash</p>');

  // Build output copied into the views tree — what excludeDirs is for.
  fs.mkdirSync(path.join(root, 'views', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'views', 'dist', 'home.ejs'), '<p>compiled</p>');

  return root;
}

// ─── run ──────────────────────────────────────────────────────────────────────

const root = writeFixture();

try {
  const app = await analyzeWorkspace(root);
  const routeFor = (p) => app.routes.find((r) => r.resolvedPath === p);

  console.log('\nExpress 4 fixture, five routes\n');
  check('routes discovered', app.routes.length, 5);

  const bare = routeFor('/bare');
  console.log('\n  /bare — plain async handler, no try/catch');
  check('  isAsync', bare.isAsync, true);
  check('  hasTryCatch', bare.hasTryCatch, false);
  check('  wrappedHandler', bare.wrappedHandler, false);
  check('  renders', bare.templateName, 'home');
  check('  reported as an async issue', hasAsyncIssue(bare), true);

  const wrapped = routeFor('/wrapped');
  console.log('\n  /wrapped — asyncHandler(async (req, reply) => reply.render(…))');
  check('  isAsync (was false before unwrapping)', wrapped.isAsync, true);
  check('  wrappedHandler', wrapped.wrappedHandler, true);
  check('  renders (was undefined before unwrapping)', wrapped.templateName, 'dash');
  check('  responseType', wrapped.responseType, 'render');
  check('  NOT reported as an async issue', hasAsyncIssue(wrapped), false);

  const guarded = routeFor('/guarded');
  console.log('\n  /guarded — async with try/catch');
  check('  isAsync', guarded.isAsync, true);
  check('  hasTryCatch', guarded.hasTryCatch, true);
  check('  not reported', hasAsyncIssue(guarded), false);

  const sync = routeFor('/sync');
  console.log('\n  /sync — synchronous handler');
  check('  isAsync', sync.isAsync, false);
  check('  not reported', hasAsyncIssue(sync), false);

  const multi = routeFor('/multi');
  console.log('\n  /multi — withOptions(fn, opts), a two-argument call');
  check('  not treated as a wrapped handler', multi.wrappedHandler, false);
  check('  not reported', hasAsyncIssue(multi), false);

  console.log('\n  templates and excludeDirs');
  check('  views/dist walked by default', app.templates.length, 3);
  check(
    '  views/dist/home.ejs is orphaned by default',
    app.orphanedTemplates.some((t) => t.file.includes(`${path.sep}dist${path.sep}`)),
    true,
  );

  const excluded = await analyzeWorkspace(root, { excludeDirs: ['dist'] });
  check('  templates with excludeDirs: ["dist"]', excluded.templates.length, 2);
  check(
    '  nothing under views/dist remains',
    excluded.templates.some((t) => t.file.includes(`${path.sep}dist${path.sep}`)),
    false,
  );
  check('  no orphans left', excluded.orphanedTemplates.length, 0);
  check('  no broken references', excluded.brokenRefs.length, 0);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\n' + '─'.repeat(72));
if (failures.length > 0) {
  console.log(`${failures.length} check(s) FAILED:\n`);
  for (const f of failures) { console.log('  ' + f + '\n'); }
  process.exit(1);
}
console.log(`${passed} checks passed`);
