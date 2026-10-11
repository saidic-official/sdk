# AGENTS.md — the SDKs (@saidic/sdk, @saidic/server, the conformance suite)

Repeats the root rules that matter here, since this folder is published as its own
repository (saidic-official/sdk). Claude Code ignores this file if any CLAUDE.md or
CLAUDE.local.md exists in this folder or above it: never add one.

## Never red

- Run `ci/before-build.sh` (exact install, type check, lint, format, build, tests, the
  size check, and the conformance adapter against the protocol's fake) before every
  publish; publish only through the monorepo's `infra/publish/publish.sh`; reviewed
  heads join the batch on the `release` branch, and a batch's deploy stands before the
  next batch is pushed; packages go to npm by the tag workflow with the owner's token,
  never by hand. Why: the pipeline runs these same checks and a newer push cancels a
  build in progress.
- `@saidic/sdk` has no dependency, stays under 15 KB minified and compressed, and
  holds the customer's token in memory alone. It has no field for an API key or the
  identity secret and refuses a `key` option outright; `@saidic/server` alone reads
  the secret and the key, on the server. Why: a browser is not a vault.
- Commit as you go, gated on the checks; no "Co-Authored-By: Claude" or "Generated
  with Claude" lines; hashes from the git output. Why: the owner's orders.

## The protocol

- The protocol of record is the docs site's protocol page, built from the docs'
  registry; the SDK follows it and never the other way: order by seq, dedupe by id,
  queue while offline and flush in order, resubscribe from the last seq after a lost
  socket, ask the app for a token once on a 4401 close whose reason is `expired` (and
  on a 401 `expired`), treat every other close in the 4000s as final and report it with
  its reason (4401 other reasons, 4403 `plan_limit`, 4404 `not_open`, 4429
  `too_many_uses`), retry every other close and a failed handshake with backoff, send
  an idempotency key on every start and send, ping every thirty seconds; the protocol
  also says a client that polls instead of holding a socket polls not under three
  seconds, which the web SDK does not do since it holds a socket. Why: the server pins
  these in section 51.6.
- Every SDK passes the conformance suite (`conformance/scenarios`, the runner in the
  backend's tests) through an adapter written to `conformance/ADAPTER.md`; an operation
  an SDK cannot do is a skip named as that SDK's gap, never a pass. A mobile SDK is
  added by writing its adapter and nothing else. Why: one suite, every SDK.
- A change to a frame, an event or a close begins in the docs' registry and the
  protocol page, then the server, then the SDK. Why: the registry tests hold all three
  to one list.
- The packages are MIT. Why: the licence the owner chose.

## The architecture document

- A change to how something works updates its section of the monorepo's
  `docs/architecture.md` in the same change; a new feature is first described under "In
  view" there and moves into the body when it is built; the code reviewer rejects a change
  that should have and did not.
  Why: the document is the one account of what Saidic is today and why each decision was
  made, and an account that lags the code misleads every agent and person who reads it.
