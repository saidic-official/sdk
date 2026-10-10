// @saidic/sdk against a fake of protocol v1 (fake-server.mjs): the REST calls, the token
// in the header alone and asked again once when refused, the offline queue in order with
// its idempotency keys, and the socket's catching up, order, dedupe, heartbeat, resume,
// token refusal and limit. Run after the build: `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Saidic, SaidicError } from '../dist/esm/index.js';
import { startFake, until } from './fake-server.mjs';

const client = (fake, more = {}) =>
  Saidic.create({ token: 'tok-1', baseUrl: fake.base, WebSocket, ...more });

test('a conversation is started, a message sent and listed; the token goes in the header alone', async () => {
  const fake = await startFake();
  try {
    const saidic = client(fake);
    const conversation = await saidic.conversations.start({ language: 'en', text: 'Hello' });
    assert.equal(conversation.status, 'open');
    const sent = await saidic.messages.send(conversation.id, 'Where is my order?');
    assert.equal(sent.from, 'customer');
    assert.equal(sent.status, 'accepted');
    const { messages, has_more } = await saidic.messages.list(conversation.id, { after: 0 });
    assert.deepEqual(
      messages.map(m => m.text),
      ['Hello', 'Where is my order?']
    );
    assert.equal(has_more, false);
    const page = await saidic.conversations.list();
    assert.equal(page.conversations[0].id, conversation.id);
    assert.equal(page.next_cursor, null);
    await saidic.conversations.requestPerson(conversation.id);
    const closed = await saidic.conversations.close(conversation.id);
    assert.equal(closed.status, 'closed');
    await assert.rejects(saidic.messages.send(conversation.id, 'More?'), error => {
      assert.ok(error instanceof SaidicError);
      assert.equal(error.code, 'conversation_closed');
      assert.equal(error.status, 409);
      assert.equal(error.requestId, 'req-fake');
      return true;
    });
    for (const [, url, authorization] of fake.state.requests) {
      assert.equal(authorization, 'Bearer tok-1');
      assert.ok(!url.includes('tok-1'), url);
    }
    // Every message and every start went with an idempotency key.
    const posts = fake.state.requests.filter(
      ([method, url]) => method === 'POST' && /messages$|conversations$/.test(url)
    );
    assert.ok(posts.every(([, , , key]) => typeof key === 'string' && key.length >= 16));
  } finally {
    await fake.stop();
  }
});

test('a key is refused: the SDK holds a customer token, never a key', () => {
  assert.throws(
    () => Saidic.create({ key: 'saidic_key_abc', token: 't' }),
    /for your server alone/
  );
  assert.throws(() => Saidic.create({}), /token or a getToken/);
});

test('a refused token is asked of the app again, once, and the request made again', async () => {
  const fake = await startFake({ tokens: ['tok-2'], expired: ['tok-old'] });
  try {
    let asked = 0;
    const saidic = Saidic.create({
      token: 'tok-old',
      getToken: () => {
        asked += 1;
        return 'tok-2';
      },
      baseUrl: fake.base,
    });
    const conversation = await saidic.conversations.start();
    assert.equal(asked, 1);
    assert.ok(conversation.id);
    // A token that stays refused is an error, not a loop.
    const stuck = Saidic.create({
      token: 'tok-old',
      getToken: () => 'tok-old',
      baseUrl: fake.base,
    });
    await assert.rejects(stuck.conversations.start(), error => error.code === 'unauthorized');
  } finally {
    await fake.stop();
  }
});

test('sent while offline: kept in order, sent when back, the same key each time, never twice', async () => {
  const fake = await startFake();
  try {
    const saidic = client(fake);
    const { id } = await saidic.conversations.start();
    fake.state.dropNext = 2; // the network is down for the next two requests
    const first = saidic.messages.send(id, 'one', { idempotencyKey: 'key-one-0000000001' });
    const second = saidic.messages.send(id, 'two');
    await until(() => fake.state.dropNext === 0);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.text, 'one');
    assert.equal(b.text, 'two');
    assert.ok(a.seq < b.seq, 'in the order they were sent');
    const stored = (await saidic.messages.list(id)).messages.map(m => m.text);
    assert.deepEqual(stored, ['one', 'two'], 'each stored once');
    const keyOne = fake.state.requests.filter(([, , , key]) => key === 'key-one-0000000001');
    assert.ok(keyOne.length >= 2, 'tried again with the same key');
    assert.equal(saidic.waiting, 0);
  } finally {
    await fake.stop();
  }
});

test('the socket: caught up on subscribe, each message once and in order, live events', async () => {
  const fake = await startFake();
  try {
    const saidic = client(fake);
    const { id } = await saidic.conversations.start({ text: 'Hi' });
    fake.reply(id, 'Hello! How can I help?');
    const seen = [];
    const statuses = [];
    const connection = saidic.connect();
    connection.on('message.created', ({ message }) => seen.push([message.seq, message.text]));
    connection.on('conversation.status', ({ status }) => statuses.push(status));
    connection.subscribe([id]);
    await until(() => seen.length === 2);
    assert.deepEqual(
      seen.map(([, text]) => text),
      ['Hi', 'Hello! How can I help?']
    );
    // A live event, an unknown one (ignored), and a message sent twice (shown once).
    fake.publish({ type: 'conversation.status', conversation_id: id, status: 'writing' });
    fake.publish({ type: 'something.new', conversation_id: id });
    const reply = fake.reply(id, 'Your order left on Monday.');
    const live = { type: 'message.created', conversation_id: id, message: reply };
    fake.publish(live);
    fake.publish(live);
    await until(() => seen.length === 3 && statuses.length === 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(seen.length, 3, 'a second copy is not shown');
    assert.deepEqual(statuses, ['writing']);
    assert.equal(connection.state, 'open');
    connection.close();
    assert.equal(connection.state, 'closed');
  } finally {
    await fake.stop();
  }
});

test('lost and opened again: subscribed with the last seq, only what was missed comes', async () => {
  const fake = await startFake();
  try {
    const saidic = client(fake);
    const { id } = await saidic.conversations.start({ text: 'Hi' });
    const seen = [];
    const states = [];
    const connection = saidic.connect();
    connection.on('message.created', ({ message }) => seen.push(message.text));
    connection.on('connection.state', ({ state }) => states.push(state));
    connection.subscribe([id]);
    await until(() => seen.length === 1);
    fake.dropSockets();
    fake.reply(id, 'Missed while away');
    await until(() => seen.length === 2, 5000);
    assert.deepEqual(seen, ['Hi', 'Missed while away']);
    assert.ok(states.includes('reconnecting') && states.at(-1) === 'open', states.join(','));
    const lastSubscribe = fake.state.subscribes.at(-1);
    assert.ok(lastSubscribe[0].after_seq !== null, 'resumed from the seq it held');
    connection.close();
  } finally {
    await fake.stop();
  }
});

test('the token expired on the socket: one new token, and open again', async () => {
  const fake = await startFake({ tokens: ['tok-new'], expired: ['tok-old'] });
  try {
    let asked = 0;
    const saidic = Saidic.create({
      token: 'tok-old',
      getToken: () => {
        asked += 1;
        return 'tok-new';
      },
      baseUrl: fake.base,
      WebSocket,
    });
    const connection = saidic.connect();
    await until(() => connection.state === 'open');
    assert.equal(asked, 1);
    connection.close();
  } finally {
    await fake.stop();
  }
});

test('refused for good: a bad token, or too many uses, closes with an error', async () => {
  const fake = await startFake({ tokens: ['tok-1'], mostSockets: 1 });
  try {
    const bad = Saidic.create({ token: 'tok-forged', baseUrl: fake.base, WebSocket });
    const errors = [];
    const refused = bad.connect();
    refused.on('error', error => errors.push(error.code));
    await until(() => refused.state === 'closed');
    assert.deepEqual(errors, ['unauthorized']);
    assert.equal(fake.state.sockets.size, 0);

    const one = client(fake).connect();
    await until(() => one.state === 'open');
    const two = client(fake).connect();
    const twoErrors = [];
    two.on('error', error => twoErrors.push([error.code, error.reason, error.close_code]));
    await until(() => two.state === 'closed');
    assert.deepEqual(twoErrors, [['too_many_uses', 'too_many_uses', 4429]]);
    one.close();
  } finally {
    await fake.stop();
  }
});

test('a handler that throws stops neither the others nor the connection', async () => {
  const fake = await startFake();
  try {
    const saidic = client(fake);
    const { id } = await saidic.conversations.start({ text: 'Hi' });
    const connection = saidic.connect();
    const seen = [];
    const thrown = [];
    const said = console.error;
    console.error = (_words, error) => thrown.push(error.message);
    connection.on('message.created', () => {
      throw new Error('the app’s own fault');
    });
    connection.on('message.created', ({ message }) => seen.push(message.text));
    connection.subscribe([id]);
    await until(() => seen.length === 1 && thrown.length === 1);
    assert.equal(connection.state, 'open');
    console.error = said;
    assert.deepEqual(thrown, ['the app’s own fault']);
    connection.close();
  } finally {
    await fake.stop();
  }
});

test('"not now" from the server or its gateway (503, 503, 502, then 200): kept, in order, one key, stored once', async () => {
  const fake = await startFake();
  try {
    const saidic = client(fake);
    const { id } = await saidic.conversations.start();
    fake.state.statusNext = [503, 503, 502];
    const first = saidic.messages.send(id, 'one', { idempotencyKey: 'key-passing-00000001' });
    const second = saidic.messages.send(id, 'two');
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual([a.text, b.text], ['one', 'two']);
    assert.ok(a.seq < b.seq, 'in the order they were sent');
    const stored = (await saidic.messages.list(id)).messages.map(m => m.text);
    assert.deepEqual(stored, ['one', 'two'], 'each stored once');
    const tries = fake.state.requests.filter(([, , , key]) => key === 'key-passing-00000001');
    assert.equal(tries.length, 4, 'three refusals, then taken: the same key each time');
    // A refusal that is a "no" is not waited through.
    fake.state.statusNext = [];
    await saidic.conversations.close(id);
    await assert.rejects(
      saidic.messages.send(id, 'late'),
      error => error.code === 'conversation_closed'
    );
  } finally {
    await fake.stop();
  }
});

test('every close in the 4000s is final, a code the SDK does not know as well; others open again', async () => {
  const fake = await startFake();
  try {
    for (const [code, reason, expected] of [
      [4403, 'plan_limit', 'plan_limit'],
      [4404, 'not_open', 'not_open'],
      [4499, 'something_new', 'refused'],
    ]) {
      fake.state.closeWith = [code, reason];
      const connection = client(fake).connect();
      const errors = [];
      connection.on('error', error => errors.push([error.code, error.reason, error.close_code]));
      await until(() => connection.state === 'closed');
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.deepEqual(errors, [[expected, reason, code]], String(code));
      assert.equal(connection.state, 'closed', 'not opened again');
    }
    // A close that is not a refusal (a restart) opens again.
    fake.state.closeWith = null;
    const connection = client(fake).connect();
    await until(() => connection.state === 'open');
    fake.dropSockets();
    await until(() => connection.state === 'reconnecting');
    await until(() => connection.state === 'open', 5000);
    connection.close();
  } finally {
    await fake.stop();
  }
});

test('requests refused together ask the app for one new token', async () => {
  const fake = await startFake({ tokens: ['tok-new'], expired: ['tok-old'] });
  try {
    let asked = 0;
    const saidic = Saidic.create({
      token: 'tok-old',
      getToken: async () => {
        asked += 1;
        await new Promise(resolve => setTimeout(resolve, 30));
        return 'tok-new';
      },
      baseUrl: fake.base,
    });
    const started = await Promise.all([
      saidic.conversations.start(),
      saidic.conversations.start(),
      saidic.conversations.start(),
    ]);
    assert.equal(started.length, 3);
    assert.equal(asked, 1);
  } finally {
    await fake.stop();
  }
});
