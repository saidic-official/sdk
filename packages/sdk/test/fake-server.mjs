// A FAKE OF THE PROTOCOL (v1), for the SDK's tests: the REST routes and the app socket as
// protocol-v1.md describes them, in memory, so the package is tested without a backend.
// The conformance suite (sdk/conformance) runs the same behaviour against the real one.
import http from 'node:http';
import { WebSocketServer } from 'ws';

export const startFake = async (options = {}) => {
  const state = {
    // Tokens the fake accepts, and the ones it refuses as expired.
    good: new Set(options.tokens ?? ['tok-1']),
    expired: new Set(options.expired ?? []),
    conversations: new Map(),
    messages: new Map(), // conversation id → messages
    replays: new Map(), // idempotency key → [status, body]
    requests: [], // [method, url, authorization, idempotency key]
    sockets: new Set(),
    subscribes: [],
    // Fail the next n REST requests as if the network were down.
    dropNext: 0,
    mostSockets: options.mostSockets ?? 8,
    nextId: 1,
    nextSeq: 100,
  };

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'X-Request-Id': 'req-fake',
      ...headers,
    });
    res.end(JSON.stringify(body));
  };
  const refuse = (res, status, code, message) =>
    json(res, status, { error: { code, message, request_id: 'req-fake' } });

  const tokenOf = header => (header || '').replace(/^Bearer /, '');
  const addMessage = (conversationId, from, text) => {
    const message = {
      id: state.nextSeq,
      seq: state.nextSeq++,
      from,
      text,
      created_at: new Date().toISOString(),
    };
    state.messages.get(conversationId).push(message);
    return message;
  };

  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://fake');
    state.requests.push([
      req.method,
      req.url,
      req.headers.authorization,
      req.headers['idempotency-key'],
    ]);
    if (state.dropNext > 0) {
      state.dropNext -= 1;
      req.socket.destroy();
      return;
    }
    const token = tokenOf(req.headers.authorization);
    if (state.expired.has(token) || !state.good.has(token)) {
      return refuse(
        res,
        401,
        'unauthorized',
        state.expired.has(token) ? 'expired' : 'bad_signature'
      );
    }
    const key = req.headers['idempotency-key'];
    if (key && state.replays.has(key)) {
      const [status, kept] = state.replays.get(key);
      return json(res, status, kept, { 'Idempotency-Replayed': 'true' });
    }
    const remember = (status, answer) => {
      if (key) state.replays.set(key, [status, answer]);
      json(res, status, answer);
    };
    const parts = url.pathname.split('/').filter(Boolean); // v1, conversations, id, ...
    if (parts[0] !== 'v1') return refuse(res, 404, 'not_found', 'Not found.');
    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'conversations') {
      const given = body ? JSON.parse(body) : {};
      const id = state.nextId++;
      const conversation = {
        id,
        status: 'open',
        created_at: new Date().toISOString(),
        language: given.language ?? 'en',
        control: { by: 'assistant' },
        customer: { external_id: 'cust-42' },
      };
      state.conversations.set(id, conversation);
      state.messages.set(id, []);
      if (given.text) addMessage(id, 'customer', given.text);
      return remember(201, conversation);
    }
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'conversations') {
      return json(res, 200, {
        conversations: [...state.conversations.values()].reverse(),
        next_cursor: null,
      });
    }
    const id = Number(parts[2]);
    const conversation = state.conversations.get(id);
    if (!conversation) return refuse(res, 404, 'not_found', 'No such conversation.');
    if (parts.length === 3 && req.method === 'GET') return json(res, 200, conversation);
    if (parts[3] === 'close') {
      conversation.status = 'closed';
      return json(res, 200, conversation);
    }
    if (parts[3] === 'request_person') return json(res, 202, {});
    if (parts[3] === 'messages' && req.method === 'POST') {
      if (conversation.status === 'closed') {
        return refuse(res, 409, 'conversation_closed', 'This conversation is closed.');
      }
      const { text } = JSON.parse(body);
      const message = addMessage(id, 'customer', text);
      return remember(201, { ...message, status: 'accepted' });
    }
    if (parts[3] === 'messages' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const list = state.messages.get(id).filter(m => m.seq > after);
      return json(res, 200, { messages: list, has_more: false });
    }
    return refuse(res, 404, 'not_found', 'Not found.');
  });

  const wss = new WebSocketServer({
    server,
    path: '/v1/ws',
    handleProtocols: protocols => (protocols.has('saidic.v1') ? 'saidic.v1' : false),
  });
  wss.on('connection', (socket, req) => {
    const offered = String(req.headers['sec-websocket-protocol'] || '')
      .split(',')
      .map(one => one.trim());
    const token = (offered.find(one => one.startsWith('saidic.token.')) || '').slice(13);
    if (state.expired.has(token)) return socket.close(4401, 'expired');
    if (!state.good.has(token)) return socket.close(4401, 'bad_signature');
    if (state.sockets.size >= state.mostSockets) return socket.close(4429, 'too_many_sockets');
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('message', raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'subscribe') {
        state.subscribes.push(frame.conversations);
        for (const { id, after_seq } of frame.conversations) {
          const list = (state.messages.get(id) || []).filter(m => m.seq > (after_seq ?? 0));
          socket.send(
            JSON.stringify({
              type: 'caught_up',
              conversation_id: id,
              messages: list,
              has_more: false,
              control: state.conversations.get(id)?.control ?? { by: 'assistant' },
            })
          );
        }
      } else if (frame.type === 'ping') {
        const latest = {};
        for (const [id, list] of state.messages)
          latest[id] = list.length ? list[list.length - 1].seq : 0;
        socket.send(JSON.stringify({ type: 'pong', latest }));
      }
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    state,
    base: `http://127.0.0.1:${port}`,
    // The server publishes an event to every open socket.
    publish: frame => state.sockets.forEach(socket => socket.send(JSON.stringify(frame))),
    reply: (conversationId, text) => {
      const message = addMessage(conversationId, 'assistant', text);
      return message;
    },
    dropSockets: () => state.sockets.forEach(socket => socket.terminate()),
    stop: async () => {
      state.sockets.forEach(socket => socket.terminate());
      wss.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
};

// Wait until a test's condition holds, or fail after a while.
export const until = async (holds, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await holds()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('waited too long');
};
