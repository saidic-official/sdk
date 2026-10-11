# The conformance adapter

The conformance suite proves an SDK against the real protocol (protocol v1;
docs/architecture.md, section 10, The public API, the SDKs and identity). It has three
parts:

- the scenarios, `sdk/conformance/scenarios/*.json`, written in the names below;
- the runner, `sdk/conformance/runner.py`, which starts the real backend in a test
  environment (a contract copy, a sandbox business let into the beta, a test key), mints
  the customers' tokens itself, plays the business's team where a scenario needs a
  person, and checks what the SDK did;
- one adapter per SDK, a small program that drives that SDK and nothing else.

An SDK passes by writing its adapter. The adapter knows nothing of scenarios: it does what
it is told and says what the SDK saw. The web SDK's is `adapters/web.mjs`
(`node sdk/conformance/adapters/web.mjs`); a Kotlin, Swift or Flutter SDK later writes its
own to this same contract.

## The process

The runner starts the adapter as a command and the two speak JSON, one object per line:
the runner writes to the adapter's standard input, the adapter writes to its standard
output. Standard error is the adapter's own log, which the runner keeps beside the report
and never reads as protocol.

The first line the adapter writes, before it is told anything, says which SDK it drives:

```json
{"ready": {"sdk": "@saidic/sdk@0.1.0"}}
```

The adapter never receives a secret or an API key. It holds what an app holds: the
customer's tokens, each asked of the runner when the SDK asks the app for one (see
"Tokens" below). This is the SDK's own rule, kept by the suite.

## What the runner asks

Each request has an id the runner chooses, an operation and its arguments:

```json
{"id": 7, "op": "send", "args": {"conversation_id": 12, "text": "Where is my order?"}}
```

The adapter answers each request once, by the same id, in whatever order the work
finishes (a send held by the offline queue is answered when it goes):

```json
{"id": 7, "ok": true, "result": {"id": 340, "seq": 340, "from": "customer", "text": "Where is my order?", "created_at": "...", "status": "accepted"}}
```

or, when the SDK refused or the server did, the SDK's error as the app would read it:

```json
{"id": 7, "ok": false, "error": {"code": "conversation_closed", "status": 409, "message": "This conversation is closed."}}
```

`code` is the server's fixed word (or the SDK's own, such as `offline` or `closed`),
`status` the HTTP status (0 where there was none), `retry_after` the seconds to wait on
`rate_limited`, and `fields` what the server said of each field on `invalid_request`. The
runner asserts `code`, and `fields` for `invalid_request`.

The operations:

| op | args | result |
| --- | --- | --- |
| `init` | `base_url`, `ws_url`, `business_id`, `adapter_name` | `{}`: the SDK's client is made; its tokens are asked of the runner |
| `start` | `language?`, `context?`, `text?` | `{conversation_id, message?}`: a new conversation of the customer's, with its first message where `text` was given |
| `open` | `conversation_id` | `{}`: the conversation is followed in real time (the SDK's connection, subscribed) |
| `send` | `conversation_id`, `text`, `idempotency_key?` | the message the server took: `id`, `seq` and the rest |
| `history` | `conversation_id`, `after?`, `before?`, `limit?` | `{messages, has_more}`, as the REST route answers |
| `list` | `cursor?` | `{conversations, next_cursor}`: the customer's conversations, a page |
| `request_person` | `conversation_id` | `{}`: the business's team is asked for |
| `close` | `conversation_id` | the closed conversation |
| `drop_socket` | none | `{}`: the socket under the SDK is lost, as a network loss would lose it; the SDK opens it again by itself |
| `offline` | none | `{}`: the network is gone (requests fail, the socket is lost and cannot open) |
| `online` | none | `{}`: the network is back, and the platform says so |
| `shutdown` | none | `{}`: the SDK's client is closed; the adapter then ends |

`base_url` is the API's address as an app would give it to the SDK; `ws_url` is the
socket's address the runner expects the SDK to use, which an adapter whose SDK derives it
from `base_url` checks and refuses with `invalid_request` when the two disagree.
`business_id` and `adapter_name` are for the report: the customer's token names the
business, and the SDK takes no business id of its own.

An operation an SDK cannot do answers `ok: false` with `code: "unsupported"`, which the
runner reports as a gap of that SDK and not a pass.

## What the adapter says unasked

Every event the SDK hands the app, as the app sees it, with the SDK's own name for it in
`type`, and when it was seen, in milliseconds of a clock that never goes back, so the
runner asserts the order without trusting the timing of lines:

```json
{"event": {"type": "message.created", "conversation_id": 12, "message": {"id": 341, "seq": 341, "from": "assistant", "text": "..."}, "at": 18234.5}}
```

The connection's own state is an event too (`connection.state`, with `state`).

When the SDK gives up for good on a refusal (a close in the 4000s: 4401 with the
verifier's reason, 4404 the API not open, 4429 too many uses), it says so once, with the
close code and the one-word reason; a refusal with no close (the app could give no token)
has `code` null:

```json
{"ended": {"code": 4401, "reason": "bad_signature"}}
```

## Tokens

When the SDK asks the app for a token, the adapter asks the runner:

```json
{"ask": "token", "ask_id": 3}
```

and the runner answers by the same number, with a token or with null to give none:

```json
{"answer": 3, "token": "eyJhbGciOiJIUzI1NiIs..."}
```

The runner stages the token cases with this alone: an expired token (minted with its
expiry past) to see the SDK refresh once, a token signed with the wrong secret to read
the 4401 and its reason after the handshake, and null to see the SDK stop.
