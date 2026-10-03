import test from 'node:test';
import assert from 'node:assert/strict';
import { proxy } from '../cloudflare-worker.mjs';

const env = { ORIGIN_URL: 'https://isolde-test.onrender.com' };

test('replaces Render wake screen with an Isolde-branded waiting page', async () => {
  const response = await proxy(new Request('https://isolde.ca/product/tobacco?ref=home'), env, async () => new Response(
    '<html><title>Render</title><p>Your service is spinning up</p></html>',
    { status: 503, headers: { 'content-type': 'text/html' } },
  ));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /ISOLDE/);
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('passes store pages, Stripe webhooks and uploads through without changing bodies', async () => {
  const source = new Request('https://isolde.ca/api/stripe/webhook?x=1', {
    method: 'POST', headers: { 'stripe-signature': 't=1,v1=abc', connection: 'keep-alive' }, body: 'signed raw body',
  });
  const response = await proxy(source, env, async upstream => {
    assert.equal(upstream.url, 'https://isolde-test.onrender.com/api/stripe/webhook?x=1');
    assert.equal(upstream.headers.get('stripe-signature'), 't=1,v1=abc');
    assert.equal(upstream.headers.get('connection'), null);
    assert.equal(await upstream.text(), 'signed raw body');
    return new Response('ok', { status: 200, headers: { 'x-store': 'isolde' } });
  });
  assert.equal(await response.text(), 'ok');
  assert.equal(response.headers.get('x-store'), 'isolde');
});

test('rejects insecure and unrelated upstream hosts', async () => {
  const response = await proxy(new Request('https://isolde.ca'), { ORIGIN_URL: 'https://example.com' });
  assert.equal(response.status, 500);
});
