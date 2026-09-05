/**
 * Wire contract for the per-client invalidation interest declaration.
 *
 * ONE definition, shared by both halves of the feature: the client builds the
 * SSE URL with `withInterestParam`, and the server route parses the same param
 * back into a per-subscriber filter. The param name and the cap therefore have
 * a single source rather than a copy on each side that can drift apart — a
 * drifted param name here fails SILENTLY (the server sees no declaration and
 * falls back to full fan-out), which is precisely the shape of bug that never
 * gets reported as one.
 *
 * Both directions are deliberately FAIL-OPEN (plan D-002): every ambiguous
 * input resolves to "no filtering", i.e. exactly today's full fan-out. The
 * failure mode of this feature is silent staleness, which no test suite
 * reliably catches and users report only as "the UI is wrong sometimes", so
 * an event is dropped only on positive knowledge that the client does not
 * want it.
 */

/**
 * Query param carrying the client's declared interest set: the query names it
 * is currently observing, comma-separated (`?queries=plans.items,work.items`).
 */
export const INTEREST_PARAM = 'queries';

/**
 * Refuse to build a filter from an implausibly large declaration rather than
 * truncating one. Truncating would silently starve whichever names fell off
 * the end — the exact failure D-002 exists to prevent — so an over-cap
 * declaration falls back to no filter, which is merely today's behaviour.
 */
export const MAX_DECLARED_QUERY_NAMES = 500;

/**
 * Parse a raw declaration into the set of names the client wants.
 *
 * Returns `undefined` — meaning NO filtering — for every ambiguous input:
 *
 *   - `null`/absent        -> undefined. An un-upgraded client, or one
 *                             mid-handshake, is never degraded.
 *   - parses to EMPTY      -> undefined, NOT "send nothing". This is the
 *                             single most dangerous misreading available
 *                             here: read as an empty allow-list it would
 *                             starve the client completely, and the symptom
 *                             (a UI that never updates) looks like a dead
 *                             connection rather than a filter bug.
 *   - over the cap         -> undefined (see MAX_DECLARED_QUERY_NAMES).
 *
 * A client that genuinely wants nothing simply does not open the stream.
 */
export function parseInterestParam(raw: string | null | undefined): Set<string> | undefined {
  if (raw === null || raw === undefined) return undefined;
  const names = new Set(
    raw
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0),
  );
  if (names.size === 0 || names.size > MAX_DECLARED_QUERY_NAMES) return undefined;
  return names;
}

/**
 * Build the SSE URL carrying `names` as this connection's declaration.
 *
 * Returns the url UNCHANGED when the declaration would be one the server is
 * required to ignore anyway (empty, or over the cap). Emitting it regardless
 * would be harmless given `parseInterestParam` refuses it too, but leaving it
 * off keeps the two sides agreeing on what a declaration MEANS, and keeps a
 * pointlessly huge param off the wire.
 *
 * Names are sorted so an unchanged set produces a byte-identical URL: the
 * reconnect path is driven by URL inequality, and a set that merely got
 * re-enumerated in a different order must not look like a change.
 */
export function withInterestParam(url: string, names: Iterable<string>): string {
  // Trim BEFORE de-duplicating, and use the same rule the parser uses: the two
  // sides must agree on what a name IS, or the client can emit a declaration
  // that the server normalises into a different set than the one intended.
  const sorted = [...new Set([...names].map((n) => n.trim()))].filter((n) => n.length > 0).sort();
  if (sorted.length === 0 || sorted.length > MAX_DECLARED_QUERY_NAMES) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${INTEREST_PARAM}=${encodeURIComponent(sorted.join(','))}`;
}
