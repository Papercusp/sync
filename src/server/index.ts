/**
 * @papercusp/sync/server — the server half of the live-query stack.
 *
 * Pairs with the client (`@papercusp/sync`): the host builds a query
 * registry + an invalidation bus + mounts the HTTP/SSE routes, and the
 * client's `useSyncQuery` reads through them with cross-process,
 * server-pushed invalidation. Everything domain/transport-specific is
 * injected — this entry point pulls in no database or framework.
 *
 * PG LISTEN/NOTIFY adapters live at the `@papercusp/sync/server/pg`
 * sub-path (re-exported here for convenience; they are still dep-free —
 * the host supplies the postgres client).
 */

export {
  NAME_NOT_FOUND,
  createResolver,
  knownQueryNames,
  isRegistered,
  type NameNotFound,
  type ArgsValidator,
  type QueryEntry,
  type QueryRegistry,
  type NamedQueryResolver,
} from './query-registry';

export {
  createInvalidationBus,
  type SyncEvent,
  type ListenSource,
  type NotifySink,
  type SubscribeHandle,
  type CreateInvalidationBusOptions,
  type InvalidationBus,
  type BridgeTarget,
} from './invalidation-bus';

export {
  createRestQueryHandler,
  createRestBatchHandler,
  createSseHandler,
  type SsePrimitives,
} from './http-routes';

export {
  createPgListenSource,
  createPgNotifySink,
  type PgSqlLike,
} from './pg-adapter';
