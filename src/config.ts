/**
 * config.ts
 *
 * Every setting this extension reads, in one place.
 *
 * Two rules shaped what is here and what isn't.
 *
 * First, defaults reproduce the behaviour of the version before settings
 * existed, exactly. An install that never opens settings.json behaves
 * identically to 1.0.11, and "no configuration required" stays true.
 *
 * Second, nothing gets a setting when there is a correct answer. The views
 * directory, template engine and entry point are all discovered from the app
 * itself and must not become the user's problem; the route grouping is already
 * a one-click control that remembers itself. What is here is the diagnostics —
 * which land in the Problems panel and stay there — and the directory walk,
 * whose cost depends on a repo's shape in a way no default can know.
 *
 * Diagnostic settings are read per-resource so one project in a multi-root
 * window can turn a check off in its own `.vscode/settings.json`. The exclude
 * list is window-scoped, because the analysis runs per project root rather
 * than per open file.
 */

import * as vscode from 'vscode';

/** Root section for every setting and command this extension contributes. */
export const CONFIG_SECTION = 'expressMap';

/**
 * Maps a severity setting's string value to a `DiagnosticSeverity`.
 * `'off'` maps to `undefined`, which every caller reads as "don't report".
 *
 * `'hint'` is the value that makes this an enum rather than a boolean: it
 * leaves the underline in the editor while keeping the entry out of the
 * Problems panel.
 */
function toSeverity(value: string): vscode.DiagnosticSeverity | undefined {
  switch (value) {
    case 'error': return vscode.DiagnosticSeverity.Error;
    case 'warning': return vscode.DiagnosticSeverity.Warning;
    case 'information': return vscode.DiagnosticSeverity.Information;
    case 'hint': return vscode.DiagnosticSeverity.Hint;
    default: return undefined; // 'off', or an unrecognised value
  }
}

function read<T>(key: string, fallback: T, resource?: vscode.Uri): T {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION, resource)
    .get<T>(key, fallback);
}

/**
 * Severity for `res.render('name')` pointing at a template that isn't in the
 * views directory, or `undefined` when off. Defaults to `error`.
 *
 * Worth being able to turn down for apps that register views directories at
 * runtime, or render templates that a build step produces, where the file is
 * genuinely absent from the source tree and genuinely present when it runs.
 */
export function brokenTemplateRefSeverity(
  resource?: vscode.Uri,
): vscode.DiagnosticSeverity | undefined {
  return toSeverity(read('diagnostics.brokenTemplateRef.severity', 'error', resource));
}

/**
 * Severity for async route handlers with no `try`/`catch`, or `undefined` when
 * off. Defaults to `warning`.
 *
 * Already suppressed wholesale for projects where the framework catches
 * rejections — Express 5, or `express-async-errors` / `express-async-handler`
 * in the dependency list — and for handlers wrapped in a helper. This is for
 * teams whose error handling this extension can't see, and for anyone who has
 * simply decided the warning isn't for them.
 */
export function asyncErrorHandlingSeverity(
  resource?: vscode.Uri,
): vscode.DiagnosticSeverity | undefined {
  return toSeverity(read('diagnostics.asyncErrorHandling.severity', 'warning', resource));
}

/**
 * Extra directory *names* to skip when walking for template files, from
 * `expressMap.excludeDirs`.
 *
 * Names rather than globs, because that is what the walk compares: it tests
 * each directory entry's own name as it descends. `node_modules`, `.git` and
 * `out` are always skipped and don't need listing; `dist` and `build` are the
 * common additions, and until now there was no way to add them.
 */
export function excludeDirs(): string[] {
  const raw = read<string[]>('excludeDirs', []);
  if (!Array.isArray(raw)) { return []; }
  return raw
    .filter((name): name is string => typeof name === 'string')
    .map(name => name.trim())
    .filter(name => name.length > 0);
}

/** True when `event` touches any setting in this extension's section. */
export function affectsThisExtension(
  event: vscode.ConfigurationChangeEvent,
): boolean {
  return event.affectsConfiguration(CONFIG_SECTION);
}

/**
 * True when `event` touches a setting that changes analysis *results* rather
 * than only how they are reported. Severity changes can reuse the last result;
 * this cannot.
 */
export function affectsAnalysis(
  event: vscode.ConfigurationChangeEvent,
): boolean {
  return event.affectsConfiguration(`${CONFIG_SECTION}.excludeDirs`);
}
