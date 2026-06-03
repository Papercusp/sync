/**
 * Named-query registry + dispatcher — the server half of @papercusp/sync.
 *
 * A `QueryRegistry` maps a dot-separated query name (`plans.items`,
 * `harnessStatus.byHarness`) to a resolver that returns a flat row array.
 * `createResolver(registry)` turns it into a `(name, args) => rows[]`
 * dispatcher with optional per-entry arg validation.
 *
 * Domain-free by construction: the registry ENTRIES are supplied by the
 * host (each owns its own data access — drizzle, raw SQL, file reads,
 * an HTTP call, anything). This module never touches a database; it only
 * dispatches. The host maps its domain onto the seam by building the
 * registry and passing it in.
 *
 * Mirrors the contract the client transport expects: the polling/SSE
 * REST endpoint returns `{ rows }` for a `(name, args)` pair, and the
 * client caches it under `['sync', name, args]`.
 */

/** Sentinel returned when a name isn't in the registry. Callers map it to
 *  a 400 (single) / per-slot error (batch). */
export const NAME_NOT_FOUND = Symbol('@papercusp/sync:NAME_NOT_FOUND');
export type NameNotFound = typeof NAME_NOT_FOUND;

/**
 * Minimal validator shape — structurally satisfied by a Zod schema
 * (`z.object({...})` has `.parse`). Kept as a tiny interface so the lib
 * takes NO schema-library dependency; the host passes whatever it uses.
 */
export interface ArgsValidator<A> {
  parse(input: unknown): A;
}

export interface QueryEntry<A = unknown> {
  /** Optional arg validation/coercion. Omit to accept args unchanged. */
  argsSchema?: ArgsValidator<A>;
  /** Resolve validated args to a flat row array. */
  resolve: (args: A) => Promise<unknown[]>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryRegistry = Record<string, QueryEntry<any>>;

export type NamedQueryResolver = (
  name: string,
  args: unknown,
) => Promise<unknown[] | NameNotFound>;

/**
 * Build a dispatcher over a registry. Validation failure throws (the
 * route handler maps it to HTTP); an unknown name returns NAME_NOT_FOUND.
 */
export function createResolver(registry: QueryRegistry): NamedQueryResolver {
  return async (name: string, args: unknown): Promise<unknown[] | NameNotFound> => {
    const entry = registry[name];
    if (!entry) return NAME_NOT_FOUND;
    const validated = entry.argsSchema ? entry.argsSchema.parse(args) : args;
    return entry.resolve(validated);
  };
}

/** Sorted list of registered names. */
export function knownQueryNames(registry: QueryRegistry): string[] {
  return Object.keys(registry).sort();
}

/** True if a name is registered. */
export function isRegistered(registry: QueryRegistry, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry, name);
}
