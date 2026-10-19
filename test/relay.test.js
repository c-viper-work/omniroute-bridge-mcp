import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuotePayload, fetchRelayQuote, fetchTransactionStatus, fetchAppFeeBalances, DEFAULT_FEE_RECIPIENT, DEFAULT_SOLANA_USER } from '../src/index.js';
import { mockRelay, USER } from './helpers.js';
const base = { originChain: 'base', destinationChain: 'arbitrum', amountRaw: '1000', originToken: 'USDC', destinationToken: 'USDC' };
test('every EVM/Solana direction has default EVM fee recipient', async () => {
  for (const [originChain, destinationChain] of [['base', 'arbitrum'], ['solana', 'base'], ['base', 'solana'], ['solana', 'solana']]) {
    const p = buildQuotePayload({ ...base, originChain, destinationChain });
    assert.deepEqual(p.appFees, [{ recipient: DEFAULT_FEE_RECIPIENT, fee: '30' }]);
    const mock = mockRelay(); const q = await fetchRelayQuote({ ...p, appFees: [] }, mock);
    assert.deepEqual(mock.calls[0].payload.appFees, p.appFees);
    assert.equal(q.fees.appFeeBps, '30');
    assert.equal(q.currencyOut.minimumAmountFormatted, '9.8');
    assert.equal(q.steps[0].items[0].checkEndpoint, '/intents/status/v2?requestId=test');
  }
});
test('payload validation and explicit fee options', () => {
  assert.equal(buildQuotePayload({ ...base, slippageTolerance: 50 }).slippageTolerance, '50');
  assert.equal(buildQuotePayload({ ...base, feeRecipient: USER, feeBps: 5 }).appFees[0].fee, '5');
  for (const override of [{ feeRecipient: DEFAULT_SOLANA_USER }, { feeBps: -1 }, { user: 'bad' }, { recipient: DEFAULT_SOLANA_USER }, { amountRaw: '0' }, { tradeType: 'bad' }, { slippageTolerance: 10001 }]) assert.throws(() => buildQuotePayload({ ...base, ...override }));
});
test('normalization, status escaping and fee balances', async () => {
  const m = mockRelay(); const q = await fetchRelayQuote(buildQuotePayload(base), m);
  assert.equal(q.requestId, 'request-1'); assert.equal(q.timeEstimateSeconds, 2);
  await fetchTransactionStatus('a&b', m); assert.ok(m.calls[1].url.endsWith('requestId=a%26b'));
  await fetchAppFeeBalances(undefined, m); assert.ok(m.calls[2].url.includes(DEFAULT_FEE_RECIPIENT));
  assert.throws(() => fetchTransactionStatus(''));
  assert.throws(() => fetchAppFeeBalances('invalid'));
});
test('HTTP errors, malformed JSON, malformed quote and timeout', async () => {
  const p = buildQuotePayload(base);
  await assert.rejects(fetchRelayQuote(p, { fetchImpl: async () => new Response('{"message":"rate limited"}', { status: 429 }) }), /429.*rate limited/);
  await assert.rejects(fetchRelayQuote(p, { fetchImpl: async () => new Response('bad') }), /invalid JSON/);
  await assert.rejects(fetchRelayQuote(p, { fetchImpl: async () => new Response('{}') }), /missing/);
  await assert.rejects(fetchRelayQuote(p, { timeoutMs: 5, fetchImpl: (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }), /timed out/);
});
test('abort signals propagate and invalid explicit fee options fail validation', async () => {
  const controller = new AbortController();
  const promise = fetchRelayQuote(buildQuotePayload(base), { signal: controller.signal, fetchImpl: (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  controller.abort(); await assert.rejects(promise, /cancelled/);
  const m = mockRelay();
  await assert.rejects(fetchRelayQuote(buildQuotePayload(base), { ...m, feeRecipient: 'bad' }));
  assert.equal(m.calls.length, 0);
});

test('HTTP boundary ignores injected fees and honors only explicit fee options', async () => {
  const payload = { ...buildQuotePayload(base), appFees: [{ recipient: USER, fee: '0' }] };
  for (const appFees of [payload.appFees, [{ recipient: 'bad', fee: 'bad' }]]) {
    const m = mockRelay();
    const q = await fetchRelayQuote({ ...payload, appFees }, m);
    assert.deepEqual(m.calls[0].payload.appFees, [{ recipient: DEFAULT_FEE_RECIPIENT, fee: '30' }]);
    assert.equal(q.fees.appFeeRecipient, DEFAULT_FEE_RECIPIENT);
    assert.equal(q.fees.appFeeBps, '30');
  }
  const m = mockRelay();
  await fetchRelayQuote(payload, { ...m, feeRecipient: USER, feeBps: 0 });
  assert.deepEqual(m.calls[0].payload.appFees, [{ recipient: USER, fee: '0' }]);
});

test('amountRaw rejects unsafe numbers and coercible objects and normalizes exact integers', () => {
  for (const amountRaw of [1000000000000000128, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, 1.5, true, null, undefined, ['123'], { toString: () => '123' }]) {
    assert.throws(() => buildQuotePayload({ ...base, amountRaw }), /amountRaw/);
  }
  for (const [amountRaw, expected] of [[Number.MAX_SAFE_INTEGER, '9007199254740991'], [1000000000000000128n, '1000000000000000128'], ['1000000000000000128', '1000000000000000128'], ['000123', '123']]) {
    assert.equal(buildQuotePayload({ ...base, amountRaw }).amount, expected);
  }
});
test('basis points accept only digit strings and safe integer numbers', () => {
  for (const key of ['feeBps', 'slippageTolerance']) {
    for (const value of [1n, ['30'], { toString: () => '30' }, true, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 0.5]) {
      assert.throws(() => buildQuotePayload({ ...base, [key]: value }), /must be an integer from 0 to 10000/);
    }
    for (const value of ['00030', 30, 0, 10000]) {
      const payload = buildQuotePayload({ ...base, [key]: value });
      assert.equal(key === 'feeBps' ? payload.appFees[0].fee : payload.slippageTolerance, String(Number(value)));
    }
  }
});
