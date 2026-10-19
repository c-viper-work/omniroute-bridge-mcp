import test from 'node:test';
import assert from 'node:assert/strict';
import { listSupportedRoutes, getBridgeQuote, getPolymarketOnboardPlan, getHyperliquidOnboardPlan, planMultiWalletGasRefuel, checkBridgeOrderStatus, callTool, TOOLS, DEFAULT_SOLANA_FEE_RECIPIENT, DEFAULT_FEE_RECIPIENT } from '../src/index.js';
import { USER, mockRelay } from './helpers.js';
const input = { fromChain: 'base', fromToken: 'USDC', amount: '10', userAddress: USER, recipientAddress: USER };
test('list routes with filter and transparent fees', () => {
  assert.equal(listSupportedRoutes().chains.length, 8);
  assert.equal(listSupportedRoutes({ chain: 'arb' }).chains[0].chainId, 42161);
  assert.equal(DEFAULT_FEE_RECIPIENT, '0x8c2279495094C284e1293cdE9DBC52cc4f55C6bd');
  assert.equal(DEFAULT_SOLANA_FEE_RECIPIENT, 'FJCcoqJHmoJyuthUY773gnxBsAY8yQuAgfYwL3zETVVW');
  assert.deepEqual(listSupportedRoutes().integratorFee, {
    recipient: DEFAULT_FEE_RECIPIENT, solanaRecipient: DEFAULT_SOLANA_FEE_RECIPIENT,
    bps: '30', percent: '0.30%', disclosure: 'Free software and no API key; network, Relay and integrator fees apply.'
  });
});
test('bridge preview vs real addresses and custom tokens', async () => {
  const mock = mockRelay();
  assert.equal((await getBridgeQuote({ ...input, toChain: 'arbitrum', toToken: 'USDC' }, mock)).previewOnly, false);
  assert.equal((await getBridgeQuote({ ...input, userAddress: undefined, toChain: 'polygon' }, mock)).previewOnly, true);
  assert.equal((await getBridgeQuote({ ...input, recipientAddress: undefined, toChain: 'solana' }, mock)).previewOnly, true);
  assert.equal((await getBridgeQuote({ ...input, fromToken: USER, fromTokenDecimals: 8, toChain: 'base' }, mock)).payload.amount, '1000000000');
});
test('Polymarket selects USDC.e, additive USD gas route, and no-gas', async () => {
  const m = mockRelay(), p = await getPolymarketOnboardPlan(input, m);
  assert.equal(p.quotes.length, 2);
  assert.equal(m.calls[0].payload.destinationCurrency, '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174');
  assert.equal(m.calls[1].payload.amount, '2000000');
  assert.equal(m.calls[1].payload.destinationCurrency, '0x' + '0'.repeat(40));
  assert.equal((await getPolymarketOnboardPlan({ ...input, includeGasTopup: false }, m)).quotes.length, 1);
  assert.equal((await getPolymarketOnboardPlan({ ...input, gasTopupAmountUsd: 0 }, m)).quotes.length, 1);
  const native = mockRelay(); await getPolymarketOnboardPlan({ ...input, fromToken: 'ETH', amount: '0.005' }, native);
  assert.equal(native.calls[1].payload.amount, '1000000000000000');
});
test('Hyperliquid targets and both cost semantics', async () => {
  const m = mockRelay();
  const p = await getHyperliquidOnboardPlan({ ...input, targetMode: 'both' }, m);
  assert.deepEqual(p.quotes.map(q => q.destinationChain.chainId), [999, 42161]);
  assert.ok(m.calls.every(c => c.payload.amount === '10000000'));
  assert.equal((await getHyperliquidOnboardPlan(input, m)).quotes.length, 1);
  await assert.rejects(getHyperliquidOnboardPlan({ ...input, targetMode: 'invalid' }, m));
});
test('refuel validates before network, aggregates exact values and preserves ordering', async () => {
  const m = mockRelay(); const args = { fromChain: 'base', fromToken: 'USDC', targetChain: 'polygon', amountPerWallet: '2', recipients: [USER, USER], senderAddress: USER };
  const p = await planMultiWalletGasRefuel(args, m);
  assert.equal(p.totalInputAmount, '4'); assert.equal(p.totalUsdFees, '0.12');
  assert.equal(p.estimatedCompletionTimeSeconds, 4);
  assert.deepEqual(p.steps.map(s => s.quoteIndex), [0, 1]);
  for (const recipients of [[], Array(21).fill(USER), [USER, 'bad']]) await assert.rejects(planMultiWalletGasRefuel({ ...args, recipients }, m));
  assert.equal(m.calls.length, 2);
  assert.equal((await checkBridgeOrderStatus({ requestId: 'test' }, m)).status, 'success');
});
test('six tools have full TDQS metadata and strict inputs', async () => {
  assert.equal(TOOLS.length, 6);
  for (const t of TOOLS) {
    assert.ok(t.annotations.title);
    assert.deepEqual({ ...t.annotations, title: undefined }, { title: undefined, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: t.name !== 'list_supported_chains_and_tokens' });
    for (const p of Object.values(t.inputSchema.properties)) assert.ok(p.description.length > 15);
  }
  await assert.rejects(callTool('nope'));
  await assert.rejects(callTool('get_cross_chain_bridge_quote', {}), /Missing/);
  await assert.rejects(callTool('list_supported_chains_and_tokens', { extra: 1 }), /Unknown argument/);
  await assert.rejects(callTool('polymarket_one_click_onboard', { fromChain: 'base', amount: '1', includeGasTopup: 'false' }), /Invalid type/);
});
test('multi-wallet concurrency is bounded and completion order does not change recipient order', async () => {
  const fixture = mockRelay(); let active = 0, maximum = 0;
  const recipients = Array.from({ length: 9 }, (_, i) => '0x' + String(i + 1).padStart(40, '0'));
  const fetchImpl = async (...args) => {
    active++; maximum = Math.max(maximum, active);
    const payload = JSON.parse(args[1].body);
    await new Promise(resolve => setTimeout(resolve, 10 - Number(payload.recipient.slice(-1))));
    active--; return fixture.fetchImpl(...args);
  };
  const p = await planMultiWalletGasRefuel({ fromChain: 'base', targetChain: 'polygon', fromToken: 'USDC', amountPerWallet: '0.123456', recipients }, { fetchImpl });
  assert.equal(maximum, 4);
  assert.equal(p.totalInputAmount, '1.111104');
  assert.deepEqual(p.quotes.map(q => q.payload.recipient), recipients);
});

test('Polymarket USD valuation preserves long decimals and rounds source spend up', async () => {
  for (const [amountUsd, gasTopupAmountUsd, expected] of [
    ['9.999999999999999', '2', '2000001'],
    ['10.00000000000000000001', '2', '2000000'],
    ['10', '2.00000000000000000001', '2000001']
  ]) {
    const m = mockRelay();
    const fetchImpl = async (...args) => {
      const data = await (await m.fetchImpl(...args)).json();
      data.details.currencyIn.amountUsd = amountUsd;
      return new Response(JSON.stringify(data));
    };
    await getPolymarketOnboardPlan({ ...input, gasTopupAmountUsd }, { fetchImpl });
    assert.equal(m.calls[1].payload.amount, expected);
  }
});
test('Polymarket rejects missing or invalid USD valuation before quoting gas', async () => {
  for (const amountUsd of [undefined, null, '', 'bad', '0', '0.000', '-1', '1e1']) {
    const m = mockRelay();
    const fetchImpl = async (...args) => {
      const data = await (await m.fetchImpl(...args)).json();
      data.details.currencyIn.amountUsd = amountUsd;
      return new Response(JSON.stringify(data));
    };
    await assert.rejects(getPolymarketOnboardPlan(input, { fetchImpl }), /amountUsd must be a positive decimal/);
    assert.equal(m.calls.length, 1);
  }
});
