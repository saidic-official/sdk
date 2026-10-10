// @saidic/server: the token it mints is the one Saidic's verifier reads (HS256 over
// header.claims with the identity secret, aud the business as text, an hour at most),
// what the verifier would refuse is refused at minting; a webhook's signature is checked
// as the backend makes it (the vector below was made by notify_out.service's own
// signature_header); the key goes in the Authorization header alone. Run after the
// build: `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SaidicServer, mintToken, verifyWebhook } from '../dist/index.js';

const parts = token => {
  const [head, body, signature] = token.split('.');
  const read = part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return { head, body, signature, header: read(head), claims: read(body) };
};

test('a token is signed as the verifier reads it, with the claims given and an hour at most', () => {
  const token = mintToken({
    secret: 's3cret',
    keyId: 'ab12cd34',
    businessId: 7,
    customerId: 42,
    email: 'ada@example.com',
    name: 'Ada',
    phone: '+2348031234567',
    facts: { plan: 'gold', order_count: '3' },
  });
  const { head, body, signature, header, claims } = parts(token);
  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT', kid: 'ab12cd34' });
  assert.equal(
    signature,
    createHmac('sha256', 's3cret').update(`${head}.${body}`).digest('base64url')
  );
  assert.equal(claims.aud, '7');
  assert.equal(claims.sub, '42');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(claims.jti && claims.jti.length >= 16);
  assert.deepEqual(
    [claims.email, claims.name, claims.phone, claims.facts],
    ['ada@example.com', 'Ada', '+2348031234567', { plan: 'gold', order_count: '3' }]
  );
  assert.equal(claims.scope, undefined, 'no scope where none is given: the widget and the API');
  // What was not given is not in it, and two tokens are never the same.
  const plain = parts(
    mintToken({ secret: 's', businessId: '7', customerId: 'c-1', ttlSeconds: 60 })
  );
  assert.deepEqual(Object.keys(plain.claims).sort(), ['aud', 'exp', 'iat', 'jti', 'sub']);
  assert.equal(plain.claims.exp - plain.claims.iat, 60);
  assert.equal(plain.header.kid, undefined);
  assert.notEqual(
    mintToken({ secret: 's', businessId: 1, customerId: 1 }),
    mintToken({ secret: 's', businessId: 1, customerId: 1 })
  );
});

test('what Saidic would refuse is refused when minting', () => {
  const base = { secret: 's', businessId: 1, customerId: 'c' };
  const refused = [
    [{ ttlSeconds: 3601 }, /ttlSeconds/],
    [{ ttlSeconds: 0 }, /ttlSeconds/],
    [{ customerId: '' }, /customerId/],
    [{ customerId: 'x'.repeat(129) }, /customerId/],
    [{ phone: '08031234567' }, /E\.164/],
    [{ facts: { 'bad key': 'v' } }, /not a key/],
    [{ facts: { k: 'v'.repeat(201) } }, /at most 200/],
    [
      { facts: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v'])) },
      /20 fields/,
    ],
    [
      {
        facts: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v'.repeat(190)])),
      },
      /2000 characters/,
    ],
    [{ secret: '' }, /secret/],
  ];
  for (const [change, words] of refused) {
    assert.throws(
      () => mintToken({ ...base, ...change }),
      words,
      JSON.stringify(change).slice(0, 60)
    );
  }
});

// Made by the backend: signature_header(['whsec_new', 'whsec_old'], 1700000000, BODY).
const BODY = '{"type":"conversation.created","data":{"session_id":7}}';
const HEADER =
  't=1700000000,v1=3fc5392c106a4351fc8288475b2314afef0d87fad3359c92356ef04b9f0e96d0,' +
  'v1=37f090f5081ac926c02f8877e5199eb709f1e3a484a25f40b8deab154fe5e945';

test('a webhook is verified as the backend signs it, with either secret during a rotation', () => {
  const now = 1700000100;
  assert.ok(verifyWebhook({ 'Saidic-Signature': HEADER }, BODY, 'whsec_new', { now }));
  assert.ok(verifyWebhook({ 'saidic-signature': HEADER }, Buffer.from(BODY), 'whsec_old', { now }));
  assert.ok(
    verifyWebhook(new Headers({ 'Saidic-Signature': HEADER }), BODY, ['x', 'whsec_old'], { now })
  );
  // Another body, another secret, a time too far, no header: refused.
  assert.equal(
    verifyWebhook({ 'Saidic-Signature': HEADER }, `${BODY} `, 'whsec_new', { now }),
    false
  );
  assert.equal(verifyWebhook({ 'Saidic-Signature': HEADER }, BODY, 'whsec_other', { now }), false);
  assert.equal(
    verifyWebhook({ 'Saidic-Signature': HEADER }, BODY, 'whsec_new', { now: 1700000000 + 301 }),
    false
  );
  assert.equal(
    verifyWebhook({ 'Saidic-Signature': HEADER }, BODY, 'whsec_new', {
      now: 1700000000 + 400,
      toleranceSeconds: 600,
    }),
    true
  );
  assert.equal(verifyWebhook({}, BODY, 'whsec_new', { now }), false);
  assert.equal(
    verifyWebhook({ 'Saidic-Signature': 'v1=zz,t=nope' }, BODY, 'whsec_new', { now }),
    false
  );
});

test('the server client sends the key in the Authorization header alone', async () => {
  const seen = [];
  const fake = async (url, init) => {
    seen.push([url, init.method, init.headers.Authorization, init.body]);
    if (url.endsWith('/customers/missing')) {
      return new Response(
        JSON.stringify({
          error: { code: 'not_found', message: 'No such customer.', request_id: 'r-1' },
        }),
        { status: 404 }
      );
    }
    return new Response(JSON.stringify({ external_id: 'c 1', email: 'a@b.co' }), { status: 200 });
  };
  const server = new SaidicServer({
    key: 'saidic_key_abc_def',
    baseUrl: 'https://api.example/',
    fetch: fake,
  });
  const customer = await server.customers.upsert('c 1', {
    email: 'a@b.co',
    facts: { plan: 'gold' },
  });
  assert.equal(customer.external_id, 'c 1');
  assert.deepEqual(seen[0].slice(0, 3), [
    'https://api.example/v1/customers/c%201',
    'PUT',
    'Bearer saidic_key_abc_def',
  ]);
  assert.deepEqual(JSON.parse(seen[0][3]), { email: 'a@b.co', facts: { plan: 'gold' } });
  assert.ok(!seen[0][0].includes('saidic_key'));
  await assert.rejects(server.customers.get('missing'), error => {
    assert.equal(error.code, 'not_found');
    assert.equal(error.status, 404);
    assert.equal(error.requestId, 'r-1');
    return true;
  });
  await assert.rejects(server.customers.upsert('c', { facts: { 'no good': 'x' } }), /not a key/);
  assert.throws(() => new SaidicServer({ key: '' }), /key is required/);
});
