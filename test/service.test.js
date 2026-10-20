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

test('same-chain identical tokens reject before HTTP, different tokens still quote', async () => {
  const m = mockRelay();
  for (const toToken of ['USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913']) await assert.rejects(getBridgeQuote({ ...input, toChain: 'base', toToken }, m), /Source and destination token cannot be identical/);
  assert.equal(m.calls.length, 0);
  await getBridgeQuote({ ...input, toChain: 'base', toToken: 'ETH' }, m);
  assert.equal(m.calls.length, 1);
});
test('Polymarket validates enabled gas only, caps at 50 and skips Polygon native POL', async () => {
  for (const gasTopupAmountUsd of ['', -1, '1e1', 50.01, '50.00000000000000000001', Infinity, null, true, false]) {
    const m = mockRelay();
    await assert.rejects(getPolymarketOnboardPlan({ ...input, gasTopupAmountUsd }, m), /non-negative decimal up to 50/);
    assert.equal(m.calls.length, 0);
    assert.equal((await getPolymarketOnboardPlan({ ...input, includeGasTopup: false, gasTopupAmountUsd }, m)).quotes.length, 1);
  }
  await assert.rejects(getPolymarketOnboardPlan({ ...input, includeGasTopup: 'false', gasTopupAmountUsd: '' }), /includeGasTopup must be a boolean/);
  assert.equal((await getPolymarketOnboardPlan({ ...input, gasTopupAmountUsd: 50 }, mockRelay())).quotes.length, 2);
  for (const fromToken of ['POL', 'native', '0x' + '0'.repeat(40)]) {
    const m = mockRelay();
    assert.equal((await getPolymarketOnboardPlan({ ...input, fromChain: 'polygon', fromToken }, m)).quotes.length, 1);
    assert.equal(m.calls.length, 1);
  }
});
test('Polymarket checks output USD and inclusive valuation ratio bounds before gas quote', async () => {
  for (const [outputUsd, valid] of [[null, false], ['', false], ['bad', false], ['0', false], ['-1', false], ['1e1', false], ['4.99', false], ['20.01', false], ['5', true], ['20', true]]) {
    const m = mockRelay();
    const fetchImpl = async (...args) => {
      const data = await (await m.fetchImpl(...args)).json();
      data.details.currencyOut.amountUsd = outputUsd;
      if (valid) data.details.currencyOut.amount = String(Number(outputUsd) * 1e6);
      return new Response(JSON.stringify(data));
    };
    const result = getPolymarketOnboardPlan(input, { fetchImpl });
    if (valid) assert.equal((await result).quotes.length, 2);
    else await assert.rejects(result, /failed sanity check against output USD/);
    assert.equal(m.calls.length, valid ? 2 : 1);
  }
});
test('MCP omits optional nulls, copies arguments and coerces safe positive numeric amounts', async () => {
  const args = { fromChain: 'base', toChain: 'polygon', amount: 1.25, fromToken: null, toToken: undefined, recipientAddress: null };
  const q = await callTool('get_cross_chain_bridge_quote', args, mockRelay());
  assert.equal(q.payload.amount, '1250000000000000000');
  assert.equal(args.amount, 1.25); assert.equal(args.fromToken, null);
  const p = await callTool('multi_wallet_gas_refuel', { fromChain: 'base', targetChain: 'polygon', amountPerWallet: 0.5, recipients: [USER] }, mockRelay());
  assert.equal(p.totalInputAmount, '0.5');
  for (const amount of [null, 0, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 1e-7]) await assert.rejects(callTool('get_cross_chain_bridge_quote', { ...args, amount }, mockRelay()), /Invalid type/);
  for (const key of ['__proto__', 'constructor', 'toString']) await assert.rejects(callTool('list_supported_chains_and_tokens', JSON.parse(`{"${key}":null}`)), /Unknown argument/);
});

test('MCP rejects null boolean and numeric options but omits optional string nulls', async () => {
  for (const key of ['includeGasTopup', 'gasTopupAmountUsd']) {
    const m = mockRelay();
    await assert.rejects(callTool('polymarket_one_click_onboard', { ...input, [key]: null }, m), /Invalid type/);
    assert.equal(m.calls.length, 0);
  }
  const q = await callTool('get_cross_chain_bridge_quote', { ...input, toChain: 'polygon', recipientAddress: null }, mockRelay());
  assert.equal(q.payload.recipient, USER);
});
test('Polymarket anchors USD to token units and caps additional input independently of USD', async () => {
  for (const [amountUsd, outputUsd, outRaw, gas, error] of [
    ['0.0001', '0.0001', '10000000', 2, /failed sanity check/],
    ['1', '1', '1000000', 2, /failed sanity check/],
    ['10', '10', '0', 2, /failed sanity check/],
    ['10', '10', null, 2, /failed sanity check/],
    ['10', '10', '1.5', 2, /failed sanity check/],
    ['10', '10', 'bad', 2, /failed sanity check/],
    ['1', '1', '1000000', 10, null],
    ['1', '1', '1000000', '10.000000000000000001', /cannot exceed 10x/]
  ]) {
    const m = mockRelay();
    const fetchImpl = async (...args) => {
      const data = await (await m.fetchImpl(...args)).json();
      Object.assign(data.details.currencyIn, { amountUsd });
      Object.assign(data.details.currencyOut, { amountUsd: outputUsd, amount: outRaw });
      return new Response(JSON.stringify(data));
    };
    // Native input isolates the independent cap from the stablecoin input check.
    const args = gas === 10 || typeof gas === 'string' ? { ...input, fromToken: 'ETH', amount: '0.001' } : input;
    const result = getPolymarketOnboardPlan({ ...args, gasTopupAmountUsd: gas }, { fetchImpl });
    if (error) {
      await assert.rejects(result, error);
      assert.equal(m.calls.length, 1);
    } else {
      const p = await result;
      assert.equal(BigInt(p.quotes[1].payload.amount), BigInt(p.quotes[0].payload.amount) * 10n);
    }
  }
});
test('same-chain Solana mint comparison preserves case', async () => {
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const args = { fromChain: 'solana', toChain: 'solana', fromToken: mint, toToken: mint, amount: '1' };
  const m = mockRelay();
  await assert.rejects(getBridgeQuote(args, m), /cannot be identical/);
  assert.equal(m.calls.length, 0);
  const differentMint = mint.slice(0, -1) + 'V';
  const q = await getBridgeQuote({ ...args, toToken: differentMint, toTokenDecimals: 6 }, m);
  assert.equal(q.payload.destinationCurrency, differentMint);
});
