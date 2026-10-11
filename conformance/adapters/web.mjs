// THE WEB SDK'S CONFORMANCE ADAPTER (docs/architecture.md, section 10): @saidic/sdk, as built,
// driven by the
// runner over JSON lines on standard input and output. It does what an app does with the
// SDK and nothing more; where an operation has no SDK call (the network lost or back),
// it does what the platform would: the socket under the SDK is lost, requests fail, and
// the platform's "online" signal is given. No internal of the SDK is touched.
//
//   node sdk/conformance/adapters/web.mjs        (after `npm run build` in sdk/)
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Saidic, SaidicError } from '../../packages/sdk/dist/esm/index.js';

const SDK = JSON.parse(
  readFileSync(new URL('../../packages/sdk/package.json', import.meta.url), 'utf8')
);
const say = line => process.stdout.write(`${JSON.stringify(line)}\n`);
const log = (...words) => console.error('[web adapter]', ...words);
const now = () => Math.round(performance.now() * 1000) / 1000;
// Ended once what was written has gone: a pipe takes its writes later.
const end = () => process.stdout.write('', () => process.exit(0));

// THE PLATFORM, as a browser has it: Node has no window events, so the "online" signal
// the SDK listens for on the global object is given by a stand-in.
if (typeof globalThis.addEventListener !== 'function') {
  const platform = new EventTarget();
  globalThis.addEventListener = platform.addEventListener.bind(platform);
  globalThis.removeEventListener = platform.removeEventListener.bind(platform);
  globalThis.dispatchEvent = platform.dispatchEvent.bind(platform);
}

// THE NETWORK under the SDK: the sockets it opened, and whether it is down. While it is
// down a request fails as an unreachable server does and a socket cannot open (it closes
// as a lost one does, 1006, without reaching the server).
let offline = false;
const live = new Set();
const RealSocket = globalThis.WebSocket;
function NetworkSocket(url, protocols) {
  if (offline) {
    const lost = {
      readyState: 3,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send() {},
      close() {},
    };
    setTimeout(() => lost.onclose?.({ code: 1006, reason: '' }), 0);
    return lost;
  }
  const socket = new RealSocket(url, protocols);
  live.add(socket);
  socket.addEventListener('close', () => live.delete(socket));
  return socket;
}
const loseSockets = () => [...live].forEach(socket => socket.close());
const networkFetch = (...given) =>
  offline ? Promise.reject(new TypeError('fetch failed: the network is down')) : fetch(...given);

// TOKENS, asked of the runner as the SDK asks the app.
let nextAsk = 1;
const asked = new Map();
const askToken = () =>
  new Promise((resolve, reject) => {
    const askId = nextAsk++;
    asked.set(askId, { resolve, reject });
    say({ ask: 'token', ask_id: askId });
  });
const answered = ({ answer, token }) => {
  const waiting = asked.get(answer);
  if (!waiting) return log('an answer to no ask:', answer);
  asked.delete(answer);
  if (typeof token === 'string' && token) waiting.resolve(token);
  else waiting.reject(new SaidicError('unauthorized', 'The runner gave no token.'));
};

// THE SDK, once init has made it.
let client = null;
let connection = null;
let closing = false;
const EVENTS = [
  'message.created',
  'conversation.status',
  'handover.started',
  'handover.ended',
  'agent.typing',
  'conversation.closed',
  'error',
  'connection.state',
];
const follow = () => {
  if (connection) return connection;
  connection = client.connect();
  for (const type of EVENTS) {
    connection.on(type, event => {
      say({ event: { type, ...event, at: now() } });
      // Given up for good: a refusal the SDK will not retry (the state is closed before
      // the error is told).
      if (type === 'error' && connection?.state === 'closed' && !closing) {
        say({ ended: { code: event.close_code ?? null, reason: event.reason ?? event.code } });
      }
    });
  }
  return connection;
};

const needClient = () => {
  if (!client) throw new SaidicError('invalid_request', 'init first.');
  return client;
};
const wsOf = base => `${base.replace(/\/+$/, '').replace(/^http/, 'ws')}/v1/ws`;

const OPS = {
  init: async ({ base_url, ws_url, business_id, adapter_name }) => {
    if (client) throw new SaidicError('invalid_request', 'init was done already.');
    if (ws_url && ws_url.replace(/\/+$/, '') !== wsOf(base_url)) {
      throw new SaidicError(
        'invalid_request',
        `This SDK opens its socket at ${wsOf(base_url)}, not ${ws_url}.`
      );
    }
    log(`init for ${adapter_name ?? 'a run'}, business ${business_id ?? '?'}`);
    client = Saidic.create({
      baseUrl: base_url,
      getToken: askToken,
      WebSocket: NetworkSocket,
      fetch: networkFetch,
    });
    return {};
  },
  start: async ({ language, context, text }) => {
    const options = {};
    if (language !== undefined) options.language = language;
    if (context !== undefined) options.context = context;
    if (text !== undefined) options.text = text;
    const conversation = await needClient().conversations.start(options);
    const result = { conversation_id: conversation.id, conversation };
    if (conversation.message) result.message = conversation.message;
    return result;
  },
  open: async ({ conversation_id }) => {
    needClient();
    follow().subscribe([conversation_id]);
    return {};
  },
  send: async ({ conversation_id, text, idempotency_key }) =>
    needClient().messages.send(
      conversation_id,
      text,
      idempotency_key ? { idempotencyKey: idempotency_key } : {}
    ),
  history: async ({ conversation_id, after, before, limit }) =>
    needClient().messages.list(conversation_id, { after, before, limit }),
  list: async ({ cursor }) => needClient().conversations.list(cursor ?? null),
  request_person: async ({ conversation_id }) => {
    await needClient().conversations.requestPerson(conversation_id);
    return {};
  },
  close: async ({ conversation_id }) => needClient().conversations.close(conversation_id),
  drop_socket: async () => {
    loseSockets();
    return {};
  },
  offline: async () => {
    offline = true;
    loseSockets();
    return {};
  },
  online: async () => {
    offline = false;
    globalThis.dispatchEvent(new Event('online'));
    return {};
  },
  shutdown: async () => {
    closing = true;
    client?.close();
    return {};
  },
};

const errorOf = error =>
  error instanceof SaidicError
    ? {
        code: error.code,
        status: error.status,
        message: error.message,
        ...(error.retryAfter !== null ? { retry_after: error.retryAfter } : {}),
        ...(Object.keys(error.fields).length ? { fields: error.fields } : {}),
      }
    : { code: 'adapter_error', status: 0, message: String(error?.message ?? error) };

const handle = async ({ id, op, args }) => {
  const run = OPS[op];
  if (!run) return say({ id, ok: false, error: { code: 'unsupported', status: 0, message: op } });
  try {
    const result = await run(args ?? {});
    say({ id, ok: true, result: result ?? {} });
  } catch (error) {
    say({ id, ok: false, error: errorOf(error) });
  }
  if (op === 'shutdown') end();
};

say({ ready: { sdk: `${SDK.name}@${SDK.version}` } });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (!line.trim()) return;
  let said;
  try {
    said = JSON.parse(line);
  } catch {
    return log('not JSON:', line);
  }
  if ('answer' in said) return answered(said);
  if ('op' in said) return void handle(said);
  log('neither an op nor an answer:', line);
});
// The runner is gone: so is the adapter.
lines.on('close', () => {
  closing = true;
  client?.close();
  end();
});
