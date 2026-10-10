// The web adapter (ADAPTER.md) against the SDK package's fake of protocol v1, driven by
// a runner of a few lines: the ready line first, init, a token asked and given, start,
// open with an event line and its time, send, the socket lost and caught up again from
// the last seq, the network down and back with a message waiting, and an error line in
// the SDK's shape. The real runner (runner.py) drives the same adapter against the real
// backend. Run after the build: `node --test conformance/adapters/web.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { startFake, until } from '../../packages/sdk/test/fake-server.mjs';

// A runner of the smallest kind: it starts the adapter, keeps every line it says, answers
// its token asks from a list, and waits for the answer to each request.
const runner = tokens => {
  const adapter = spawn(process.execPath, [new URL('./web.mjs', import.meta.url).pathname], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = [];
  const waiting = new Map();
  let next = 1;
  createInterface({ input: adapter.stdout }).on('line', line => {
    const said = JSON.parse(line);
    lines.push(said);
    if (said.ask === 'token') {
      const token = tokens.length ? tokens.shift() : null;
      adapter.stdin.write(`${JSON.stringify({ answer: said.ask_id, token })}\n`);
    }
    if ('id' in said && waiting.has(said.id)) {
      waiting.get(said.id)(said);
      waiting.delete(said.id);
    }
  });
  const ask = (op, args = {}) =>
    new Promise(resolve => {
      const id = next++;
      waiting.set(id, resolve);
      adapter.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  const events = type => lines.filter(line => line.event?.type === type).map(line => line.event);
  return { adapter, lines, ask, events };
};

test('the web adapter drives the SDK as ADAPTER.md has it', async () => {
  const fake = await startFake({ tokens: ['tok-1'] });
  const run = runner(['tok-1']);
  try {
    await until(() => run.lines.length > 0);
    assert.match(run.lines[0].ready?.sdk ?? '', /^@saidic\/sdk@\d+\.\d+\.\d+/);

    // A socket address the SDK does not use is refused at init, as the contract asks.
    const wrong = await run.ask('init', { base_url: fake.base, ws_url: 'ws://elsewhere/ws' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error.code, 'invalid_request');
    const made = await run.ask('init', {
      base_url: fake.base,
      ws_url: `${fake.base.replace('http', 'ws')}/v1/ws`,
      business_id: 7,
      adapter_name: 'web',
    });
    assert.deepEqual(made, { id: made.id, ok: true, result: {} });

    // The first request asks the runner for a token: asked once, by number.
    const started = await run.ask('start', { language: 'en', text: 'Hello' });
    assert.equal(started.ok, true, JSON.stringify(started));
    const conversationId = started.result.conversation_id;
    assert.ok(conversationId > 0);
    assert.equal(run.lines.filter(line => line.ask === 'token').length, 1);
    assert.equal(fake.state.requests[0][2], 'Bearer tok-1');

    // Followed: the catch-up gives the first message as an event line, with its time.
    assert.equal((await run.ask('open', { conversation_id: conversationId })).ok, true);
    await until(() => run.events('message.created').length === 1);
    const [hello] = run.events('message.created');
    assert.equal(hello.conversation_id, conversationId);
    assert.equal(hello.message.text, 'Hello');
    assert.equal(typeof hello.at, 'number');

    const sent = await run.ask('send', { conversation_id: conversationId, text: 'Where?' });
    assert.equal(sent.result.status, 'accepted');

    // The socket lost: the SDK opens it again and subscribes from the last seq it holds.
    await until(() => fake.state.subscribes.length === 1);
    assert.equal((await run.ask('drop_socket')).ok, true);
    await until(() => fake.state.subscribes.length === 2);
    assert.equal(fake.state.subscribes[1][0].after_seq, hello.message.seq);
    const reply = fake.reply(conversationId, 'Tomorrow.');
    fake.publish({ type: 'message.created', conversation_id: conversationId, message: reply });
    await until(() => run.events('message.created').some(e => e.message.text === 'Tomorrow.'));
    const seen = run.events('message.created');
    assert.ok(seen.every((event, i) => i === 0 || event.at >= seen[i - 1].at));

    // The network down: a message waits; back, it goes, and the socket opens again.
    assert.equal((await run.ask('offline')).ok, true);
    const before = fake.state.requests.length;
    const waiting = run.ask('send', { conversation_id: conversationId, text: 'Still there?' });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(fake.state.requests.length, before, 'nothing reaches the server while offline');
    assert.equal((await run.ask('online')).ok, true);
    const went = await waiting;
    assert.equal(went.ok, true, JSON.stringify(went));
    assert.equal(went.result.text, 'Still there?');
    await until(() => run.events('connection.state').some(e => e.state === 'open'), 5000);

    // Closed, and a send refused: the error line in the SDK's shape.
    assert.equal((await run.ask('close', { conversation_id: conversationId })).ok, true);
    const refused = await run.ask('send', { conversation_id: conversationId, text: 'More?' });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'conversation_closed');
    assert.equal(refused.error.status, 409);

    const listed = await run.ask('list');
    assert.equal(listed.result.conversations[0].id, conversationId);
    assert.equal(listed.result.next_cursor, null);
    const history = await run.ask('history', { conversation_id: conversationId, after: 0 });
    assert.deepEqual(
      history.result.messages.map(m => m.text),
      ['Hello', 'Where?', 'Tomorrow.', 'Still there?']
    );
    assert.equal((await run.ask('nonsense')).error.code, 'unsupported');

    const closing = new Promise(resolve => run.adapter.on('exit', resolve));
    assert.equal((await run.ask('shutdown')).ok, true);
    assert.equal(await closing, 0);
  } finally {
    run.adapter.kill();
    await fake.stop();
  }
});

test('a refused token ends the connection with its close code and reason', async () => {
  const fake = await startFake({ tokens: ['tok-1'] });
  const run = runner(['tok-forged']);
  try {
    await run.ask('init', { base_url: fake.base, business_id: 7, adapter_name: 'web' });
    // A conversation made by another client of the fake, to follow.
    assert.equal((await run.ask('open', { conversation_id: 1 })).ok, true);
    await until(() => run.lines.some(line => line.ended));
    const { ended } = run.lines.find(line => line.ended);
    assert.deepEqual(ended, { code: 4401, reason: 'bad_signature' });

    // No token at all: the request is refused as the app's getToken refusing it would be.
    const none = runner([]);
    try {
      await none.ask('init', { base_url: fake.base });
      const refused = await none.ask('list');
      assert.equal(refused.ok, false);
      assert.equal(refused.error.code, 'unauthorized');
    } finally {
      none.adapter.kill();
    }
  } finally {
    run.adapter.kill();
    await fake.stop();
  }
});
