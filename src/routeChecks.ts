import type { Route } from './types';

/**
 * True when a route should be reported under "Potential Issues" as an async
 * handler with no error handling.
 *
 * This lives on its own because the condition was written out by hand in five
 * places — the diagnostic, the language model tool's summary and issue list,
 * and three groupings in the tree — and any change to it had to be made in all
 * five or the panel, the Problems entry and the tree badge would disagree
 * about the same route.
 *
 * The parts:
 *
 *  - `isAsync` — the handler is an `async` function. A synchronous handler that
 *    throws is caught by Express in every version.
 *  - `hasTryCatch` — no `try` anywhere in the handler body. Handlers that
 *    aren't function literals count as handled, since there is nothing to read.
 *  - `asyncErrorsSafe` — stamped per-route rather than per-workspace, so a
 *    multi-project window where one app is on Express 5 and another is on
 *    Express 4 reports each correctly.
 *  - `wrappedHandler` — the handler was registered through a wrapper call, so
 *    the async flags describe the function inside it. Wrapped handlers were
 *    already never warned about, back when the wrapper made them invisible and
 *    `isAsync` came out false; the flag keeps that true now that they are read
 *    properly, which is what makes seeing through wrappers a change to the
 *    data and not to the warnings.
 */
export function hasAsyncIssue(route: Route): boolean {
  return (
    route.isAsync &&
    !route.hasTryCatch &&
    !route.asyncErrorsSafe &&
    !route.wrappedHandler
  );
}
