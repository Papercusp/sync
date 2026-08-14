/** Canonical demo-identity transport contract shared by browser and server. */
export const DEMO_PRINCIPAL_HEADER = 'x-demo-principal';
export const DEMO_PRINCIPAL_QUERY_PARAM = 'demoPrincipal';

/**
 * Cache keys use null for intentionally public requests. Keeping that state
 * explicit prevents an absent principal from collapsing into a named user.
 */
export type DemoPrincipal = string | null;

export function normalizeDemoPrincipal(value: unknown): DemoPrincipal {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function syncQueryKey(
  principal: unknown,
  queryName: string,
  args: Record<string, unknown>,
) {
  return ['sync', normalizeDemoPrincipal(principal), queryName, args] as const;
}

/** Append the EventSource-compatible half of the principal convention. */
export function appendDemoPrincipalQuery(url: string, principal: unknown): string {
  const normalized = normalizeDemoPrincipal(principal);
  if (!normalized) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${DEMO_PRINCIPAL_QUERY_PARAM}=${encodeURIComponent(normalized)}`;
}
