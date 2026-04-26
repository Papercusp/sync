import { queries } from '@restart/zero';

/**
 * Resolve a dot-separated query name into a ZQL expression.
 * E.g. 'products.page' -> queries.products.page(args)
 */
export function resolveQuery(queryName: string, args: Record<string, unknown>): any {
  // 'noop' and '' are sentinel values used by useSyncQuery when a hook
  // must fire unconditionally but the query is disabled. Zero's useQuery
  // still calls this resolver before checking `enabled`, so we return
  // undefined here and let the enabled:false flag suppress execution.
  if (!queryName || queryName === 'noop') return undefined;

  const parts = queryName.split('.');
  let registry: any = queries;
  for (const part of parts) {
    if (registry == null || typeof registry !== 'object') {
      throw new Error(`Unknown query: '${queryName}' (failed at '${part}')`);
    }
    registry = registry[part];
  }
  if (typeof registry !== 'function') {
    throw new Error(`Query '${queryName}' is not a function — got ${typeof registry}`);
  }
  return registry(args);
}
