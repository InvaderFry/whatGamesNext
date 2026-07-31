/**
 * Minimal query-string state, in place of a router.
 *
 * Writes merge into the existing params, so independent callers can each own a
 * disjoint set of keys without clobbering one another. Uses `replaceState`
 * only: the point is that a view can be bookmarked, shared and reloaded, not
 * that every filter change becomes a history entry.
 */

export function readUrl(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** Merge `values` into the query string. A null or empty value drops the key. */
export function writeUrl(values: Record<string, string | null>): void {
  const params = readUrl();
  for (const [key, value] of Object.entries(values)) {
    if (value == null || value === "") params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
}
