# @papercusp/sync

Schema-agnostic client sync transports for [Zero](https://zero.rocicorp.dev)
+ SSE, with reconnect and backpressure handling. A `SyncProvider` picks a
transport by deployment context and exposes the live query handle to the app.

- **SSE transport** (`transports/sse`) — the desktop-primary path:
  consumes a server endpoint that pushes invalidate/update over PG
  `LISTEN/NOTIFY`, with resilient reconnect (via `@papercusp/sse`).
- **WebSocket transport** (`transports/websocket`) — Zero's WS path, with a
  per-page Zero-instance cache (keyed on a brand-neutral window global) so
  remounts don't spin up duplicate sockets.

## Schema-agnostic by injection

The lib never imports a concrete Zero schema. Consumers inject their own
schema/query package (e.g. one app's shop schema, another's harness
schema) through the provider, so `@papercusp/sync` stays domain-free —
it transports whatever query shape you give it.

## Status

Submodule under `github.com/Papercusp/`. The SSE-vs-WS selection and the
desktop-primary decision live in the consuming app's provider (for the
operator: `apps/operator/providers/HarnessSyncProvider.tsx`).
