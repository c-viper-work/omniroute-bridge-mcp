import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { getBridgeQuote, getPolymarketOnboardPlan, getHyperliquidOnboardPlan, planMultiWalletGasRefuel } from '../docs/lib/service.js';
import { WalletExecutor, preflight, cliCommand, shellQuote, webUrl } from '../docs/lib/wallet.js';
import { USER, mockRelay } from './helpers.js';
import { DEFAULT_EVM_USER, DEFAULT_SOLANA_USER } from '../docs/lib/constants.js';
const html = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../docs/app.js', import.meta.url), 'utf8');
const FEE = [{ recipient: '0x8c2279495094C284e1293cdE9DBC52cc4f55C6bd', fee: '30' }];
const bridgeArgs = { fromChain: 'base', toChain: 'polygon', fromToken: 'USDC', amount: '10', userAddress: USER, recipientAddress: USER };
async function fixture() { const relay = mockRelay(); const q = await getBridgeQuote(bridgeArgs, relay); return { quotes: [q], previewOnly: false }; }
test('only dedicated project fee addresses are configured across the repository', async () => {
  const { DEFAULT_FEE_RECIPIENT, DEFAULT_SOLANA_FEE_RECIPIENT } = await import('../src/constants.js');
  assert.equal(DEFAULT_FEE_RECIPIENT, '0x8c2279495094C284e1293cdE9DBC52cc4f55C6bd');
  assert.equal(DEFAULT_SOLANA_FEE_RECIPIENT, 'FJCcoqJHmoJyuthUY773gnxBsAY8yQuAgfYwL3zETVVW');
  assert.equal(html.includes(DEFAULT_FEE_RECIPIENT), true);
  assert.equal(html.includes(DEFAULT_SOLANA_FEE_RECIPIENT), true);
});
function provider(overrides = {}) {
  const calls = []; let sequence = 0;
  return { calls, async request(req) { calls.push(req); if (overrides[req.method]) return overrides[req.method](req);
    return { eth_chainId: '0x2105', eth_accounts: [USER], eth_sendTransaction: '0x' + (++sequence).toString(16).padStart(64,'0'), eth_getTransactionReceipt: { status: '0x1' } }[req.method];
  } };
}
test('static app structure, accessible tabs, labels, dark mobile layout and deployment paths', async () => {
  assert.match(html, /<!doctype html>/i); assert.equal((html.match(/role="tab"/g) ?? []).length, 3);
  for (const name of ['Instant Cross-Chain Bridge', 'Polymarket &amp; Hyperliquid Express', 'Multi-Wallet Gas Refuel']) assert.ok(html.includes(name));
  for (const marker of ['aria-live="polite"', ':focus-visible', '@media(max-width:760px)', 'color-scheme:dark', 'type="module" src="./app.js"', '0.30%', FEE[0].recipient, 'FJCcoqJHmoJyuthUY773gnxBsAY8yQuAgfYwL3zETVVW']) assert.ok(html.includes(marker), marker);
  for (const control of html.matchAll(/<(input|select|textarea)\b[^>]*id="([^"]+)"/g)) assert.ok(html.slice(0, control.index).lastIndexOf('<label') > html.slice(0, control.index).lastIndexOf('</label>'), control[2]);
  assert.ok(!html.includes('../src')); await assert.rejects(access(new URL('../docs/FRONTEND_HANDOFF.md', import.meta.url)));
});
test('deployed shared modules have exact byte parity', async () => {
  for (const name of ['constants', 'relay', 'service']) assert.equal(await readFile(new URL(`../docs/lib/${name}.js`, import.meta.url), 'utf8'), await readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8'));
});
test('social preview metadata points to the standalone 1200×630 PNG and SVG cards', async () => {
  const url = 'https://c-viper-work.github.io/omniroute-bridge-mcp/og-card.png';
  assert.ok(html.includes(`<meta property="og:image" content="${url}">`));
  assert.ok(html.includes(`<meta name="twitter:image" content="${url}">`));
  assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
  const png = await readFile(new URL('../docs/og-card.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  const svg = await readFile(new URL('../docs/og-card.svg', import.meta.url), 'utf8');
  assert.match(svg, /^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*width="1200"[^>]*height="630"[^>]*viewBox="0 0 1200 630"[^>]*>[\s\S]*<\/svg>\s*$/);
  assert.doesNotMatch(svg, /&(?!amp;|lt;|gt;|quot;|apos;)|<script|<foreignObject|href=/);
  for (const label of ['OmniRoute', 'Powered by Relay Protocol', 'Polymarket', 'Hyperliquid', '0 npm Dependencies', 'Read-Only MCP', 'Locked CSP', '8 Chains']) assert.ok(svg.includes(label), label);
});
test('security: no HTML interpolation, external scripts, stored identities or secrets', async () => {
  const sources = [html, app, ...await Promise.all(['wallet','constants','service','relay'].map(n => readFile(new URL(`../docs/lib/${n}.js`, import.meta.url),'utf8')))];
  for (const source of sources) {
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|localStorage|sessionStorage/);
    assert.doesNotMatch(source, /(?:sk-[A-Za-z0-9]{20,}|BEGIN (?:RSA |EC )?PRIVATE KEY|AKIA[A-Z0-9]{16})/);
  }
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/);
  assert.match(html, /connect-src https:\/\/api\.relay\.link;/); assert.match(app, /\.textContent = value/);
});
test('all browser flows POST direct Relay quotes with fixed fee, exact budgets and ordered recipients', async () => {
  const relay = mockRelay();
  await getBridgeQuote(bridgeArgs, relay);
  await getBridgeQuote({ ...bridgeArgs, fromChain: 'solana', fromToken: 'SOL', userAddress: undefined }, relay);
  const poly = await getPolymarketOnboardPlan({ ...bridgeArgs, includeGasTopup: true, gasTopupAmountUsd: '2' }, relay); assert.equal(poly.quotes.length, 2); assert.equal(poly.quotes[1].payload.amount, '2000000');
  const hyper = await getHyperliquidOnboardPlan({ ...bridgeArgs, targetMode: 'both' }, relay); assert.deepEqual(hyper.quotes.map(q=>q.destinationChain.slug), ['hyperevm','arbitrum']); assert.equal(hyper.quotes.reduce((s,q)=>s+BigInt(q.payload.amount),0n),20000000n);
  const other = '0x2222222222222222222222222222222222222222';
  const refuel = await planMultiWalletGasRefuel({ fromChain: 'base', fromToken: 'USDC', targetChain: 'polygon', amountPerWallet: '2.01', recipients: [USER, other], senderAddress: USER }, relay);
  assert.equal(refuel.totalInputAmount, '4.02'); assert.deepEqual(refuel.quotes.map(q=>q.payload.recipient),[USER,other]);
  for (const c of relay.calls) { assert.equal(c.url,'https://api.relay.link/quote'); assert.equal(c.method,'POST'); assert.deepEqual(c.payload.appFees,FEE); }
});
test('previews, bad VM addresses, exact decimals and recipient limits', async () => {
  const relay = mockRelay(); const q = await getBridgeQuote({ ...bridgeArgs, userAddress: undefined }, relay); assert.equal(q.previewOnly,true);
  for (const patch of [{ amount: '1e2' }, { amount: '0.0000001' }, { toChain: 'solana', recipientAddress: USER }]) await assert.rejects(getBridgeQuote({ ...bridgeArgs,...patch },relay));
  for (const recipients of [[],Array(21).fill(USER)]) await assert.rejects(planMultiWalletGasRefuel({fromChain:'base',targetChain:'polygon',amountPerWallet:'1',recipients},relay));
});
test('whole-plan preflight blocks signatures, Solana, malformed calldata, wrong sender and chain before prompts', async () => {
  for (const mutate of [p=>p.previewOnly=true,p=>p.quotes[0].originChain.vmType='svm',p=>p.quotes[0].steps.push({kind:'signature',items:[]}),p=>p.quotes[0].steps[0].items[0].data.data='0xabc',p=>p.quotes[0].steps[0].items[0].data.from='0x2222222222222222222222222222222222222222',p=>p.quotes[0].steps[0].items[0].data.chainId=1,p=>p.quotes[0].quotedAt='invalid']) {
    const p = structuredClone(await fixture()); mutate(p); const wallet=provider(); await assert.rejects(new WalletExecutor(wallet).execute(p,USER)); assert.equal(wallet.calls.length,0);
  }
});
test('quantity conversion, allowlisted fields, step order and receipts before dependent sends', async () => {
  const p = await fixture(); const d=p.quotes[0].steps[0].items[0].data; d.gas='21000';d.nonce='0';d.extra='untrusted';p.quotes[0].steps.push(structuredClone(p.quotes[0].steps[0]));
  const wallet=provider(), progress=[]; await new WalletExecutor(wallet).execute(p,USER,{progress:e=>progress.push(e)});
  const sent=wallet.calls.filter(c=>c.method==='eth_sendTransaction'); assert.equal(sent.length,2); for (const request of sent) assert.equal(request.params[0].chainId, '0x2105'); assert.equal(sent[0].params[0].gas,'0x5208'); assert.equal(sent[0].params[0].nonce,'0x0'); assert.equal(sent[0].params[0].extra,undefined);
  const methods=wallet.calls.map(c=>c.method); assert.ok(methods.indexOf('eth_getTransactionReceipt')<methods.lastIndexOf('eth_sendTransaction')); assert.equal(progress.length,4); assert.match(progress[0].status,/Submitted/);
});
test('stale quotes and changed accounts never send; chain switch requires fresh review', async () => {
  const p=await fixture(); p.quotes[0].quotedAt=new Date(Date.now()-61000).toISOString(); assert.throws(()=>preflight(p,USER),/expired/);
  for (const overrides of [{eth_accounts:()=>[]},{eth_chainId:()=> '0x1'}]) { const wallet=provider(overrides); await assert.rejects(new WalletExecutor(wallet).execute(await fixture(),USER)); assert.ok(!wallet.calls.some(c=>c.method==='eth_sendTransaction')); }
});
test('receipt failure and timeout stop remaining transactions and preserve submitted hash',async()=>{
  for (const receipt of [{status:'0x0'},null]) {
    const p=await fixture();p.quotes[0].steps.push(structuredClone(p.quotes[0].steps[0]));const wallet=provider({eth_getTransactionReceipt:()=>receipt});let now=Date.now();const progress=[];
    const runner=new WalletExecutor(wallet,{now:()=>now,sleep:async()=>{now+=2000;},receiptTimeout:1000});await assert.rejects(runner.execute(p,USER,{progress:e=>progress.push(e)}),/failed|timeout/);
    assert.equal(wallet.calls.filter(c=>c.method==='eth_sendTransaction').length,1);assert.ok(progress[0].hash);await assert.rejects(runner.execute(p,USER),/already started/);
  }
});
test('duplicate click, form invalidation, and unknown submission never auto-resend',async()=>{
  const p=await fixture(),wallet=provider();const runner=new WalletExecutor(wallet);const first=runner.execute(p,USER);await assert.rejects(runner.execute(p,USER),/already started/);await first;
  const noSend=provider();await assert.rejects(new WalletExecutor(noSend).execute(await fixture(),USER,{valid:()=>false}),/invalidated/);assert.equal(noSend.calls.length,0);
  const unknown=provider({eth_sendTransaction:()=>{throw new Error('disconnected');}});const exec=new WalletExecutor(unknown),q=await fixture();await assert.rejects(exec.execute(q,USER),/Check wallet history/);await assert.rejects(exec.execute(q,USER),/already started/);assert.equal(unknown.calls.filter(c=>c.method==='eth_sendTransaction').length,1);
});
test('CLI export quotes shell metacharacters and includes all route inputs',()=>{
  assert.equal(shellQuote("a'b;$(x)"),"'a'\\''b;$(x)'");
  const c=cliCommand('polymarket',{...bridgeArgs,includeGasTopup:false,gasTopupAmountUsd:'2'});assert.match(c,/--no-gas/);assert.match(c,/--sender '/);assert.match(c,/--gas-usd '2'/);assert.ok(c.endsWith('--json'));
  const noGas=cliCommand('polymarket',{...bridgeArgs,includeGasTopup:false,gasTopupAmountUsd:''});assert.match(noGas,/--no-gas/);assert.doesNotMatch(noGas,/--gas-usd/);
});
// Minimal DOM harness executes the real browser event handlers with synthetic Relay/provider.
test('quick controls are non-submit buttons and CSP remains exact', () => {
  for (const id of ['amt-01', 'amt-1', 'amt-25', 'amt-100', 'amt-500', 'preset-polymarket', 'preset-hyperliquid', 'preset-solana']) {
    const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, id); assert.match(tag, /type="button"/);
  }
  assert.equal(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1], "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src https://api.relay.link; img-src 'self' data:; base-uri 'none'; form-action 'none'");
});
test('quick amount chips update amount and invalidate quotes without fetching', async () => {
  const { els, relay } = await ui();
  for (const [id, amount] of [['amt-01', '0.1'], ['amt-1', '1'], ['amt-25', '25'], ['amt-100', '100'], ['amt-500', '500']]) {
    els.get('amount').value = '2'; await els.get('quote-form').fire('submit');
    const count = relay.calls.length;
    await els.get(id).click();
    assert.equal(els.get('amount').value, amount); assert.equal(relay.calls.length, count);
    assert.equal(els.get('copy-json').disabled, true); assert.equal(els.get('results').children.length, 0);
    assert.match(els.get('budget').textContent, /source-token units/);
  }
});
test('quick presets refresh token options, select tabs and submit actual route requests', async () => {
  const { els, relay, wallet, context } = await ui();
  const constants = await import('../docs/lib/constants.js');
  for (const [preset, chain, token, amount, destinations] of [
    ['solana', 'solana', 'SOL', '1', [8453]],
    ['hyperliquid', 'base', 'ETH', '0.05', [999]],
    ['polymarket', 'base', 'USDC', '100', [137, 137]],
  ]) {
    els.get('include-gas').checked = false; els.get('gas-usd').value = '9';
    const start = relay.calls.length;
    await els.get('preset-' + preset).click(); await els.get('quote-form').submission;
    assert.equal(els.get('from-chain').value, chain); assert.equal(els.get('from-token').value, token); assert.equal(els.get('amount').value, amount);
    assert.ok(els.get('from-token').children.some(o => o.value === token));
    const requests = relay.calls.slice(start).map(c => c.payload);
    assert.deepEqual(requests.map(p => p.destinationChainId), destinations);
    assert.equal(requests[0].originCurrency, constants.CHAINS[chain].tokens[token].address);
    assert.equal(requests[0].amount, constants.parseUnits(amount, constants.CHAINS[chain].tokens[token].decimals).toString());
    assert.equal(els.get(preset === 'solana' ? 'tab-bridge' : 'tab-express').attributes['aria-selected'], 'true');
    if (preset === 'solana') { assert.equal(els.get('to-token').value, 'USDC'); assert.equal(requests[0].destinationCurrency, constants.CHAINS.base.tokens.USDC.address); }
    else assert.equal(els.get('express-mode').value, preset === 'polymarket' ? 'polymarket' : 'hyperevm_hype');
    if (preset === 'polymarket') { assert.equal(els.get('include-gas').checked, true); assert.equal(els.get('gas-usd').value, '2'); }
    await els.get('copy-json').click(); assert.ok(JSON.parse(context.copied).quotes.length);
  }
  assert.equal(wallet.calls.length, 0);
});
test('presets preserve recipients and reject malformed or wrong-VM input', async () => {
  for (const preset of ['solana', 'polymarket', 'hyperliquid']) {
    const { els, relay } = await ui();
    await els.get('connect').click();
    for (const recipient of ['0x1234', DEFAULT_SOLANA_USER, ` ${USER} `]) {
      els.get('recipient').value = recipient;
      const start = relay.calls.length;
      await els.get('preset-' + preset).click(); await els.get('quote-form').submission;
      assert.equal(els.get('recipient').value, recipient);
      const requests = relay.calls.slice(start);
      if (recipient.includes(USER)) {
        assert.equal(requests.length, preset === 'polymarket' ? 2 : 1);
        assert.ok(requests.every(c => c.payload.recipient === USER));
        assert.equal(els.get('copy-json').disabled, false);
      } else {
        assert.equal(requests.length, 0);
        assert.match(els.get('status').textContent, /Recipient must be a valid EVM address/);
        assert.equal(els.get('execute').disabled, true);
        assert.equal(els.get('copy-json').disabled, true);
      }
    }
  }
});
test('presets preserve manual senders so invalid input fails validation', async () => {
  for (const connected of [false, true]) {
    for (const [preset, sender, vm] of [
      ['solana', 'custom-sender', 'Solana'],
      ['solana', '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', 'Solana'],
      ['polymarket', '0x1234', 'EVM'],
      ['hyperliquid', DEFAULT_SOLANA_USER, 'EVM'],
    ]) {
      const { els, relay } = await ui();
      if (connected) await els.get('connect').click();
      els.get('sender').value = sender;
      await els.get('preset-' + preset).click(); await els.get('quote-form').submission;
      assert.equal(els.get('sender').value, sender);
      assert.equal(relay.calls.length, 0);
      assert.match(els.get('status').textContent, new RegExp(`Sender must be a valid ${vm} address`));
      assert.equal(els.get('execute').disabled, true);
    }
  }
});
test('connected EVM wallet survives Solana and EVM preset round trips', async () => {
  const { els, relay, wallet, context } = await ui();
  await els.get('connect').click();
  assert.equal(els.get('sender').value, USER);
  await els.get('preset-solana').click(); await els.get('quote-form').submission;
  assert.equal(els.get('sender').value, '');
  assert.equal(els.get('recipient').value, '');
  assert.equal(relay.calls.length, 1);
  assert.equal(relay.calls[0].payload.destinationChainId, 8453);
  assert.equal(relay.calls[0].payload.recipient, DEFAULT_EVM_USER);
  assert.equal(els.get('copy-json').disabled, false);
  await els.get('copy-json').click();
  const solana = JSON.parse(context.copied).quotes[0];
  assert.equal(solana.originChain.slug, 'solana');
  assert.equal(solana.previewOnly, true);
  await els.get('preset-polymarket').click(); await els.get('quote-form').submission;
  assert.equal(els.get('sender').value, USER);
  assert.deepEqual(relay.calls.slice(1).map(c => [c.payload.originChainId, c.payload.destinationChainId, c.payload.user]), [[8453, 137, USER], [8453, 137, USER]]);
  assert.equal(els.get('copy-json').disabled, false);
  assert.equal(els.get('execute').disabled, false);
  assert.deepEqual(wallet.calls.map(c => c.method), ['eth_requestAccounts']);
});
async function ui(search = '', hash = '') {
  class Element {
    constructor(id='') {this.id=id;this.children=[];this.listeners={};this.value='';this.disabled=false;this.dataset={};this.attributes={};}
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
    async fire(name,event={}){for(const fn of this.listeners[name]??[])await fn({preventDefault(){},...event});}
    append(el){this.children.push(el);}
    replaceChildren(...els){this.children=els;if(this.id.endsWith('-chain')||this.id.endsWith('-token'))this.value=els[0]?.value??'';}
    setAttribute(k,v){this.attributes[k]=v;}
    focus(){this.focused=true;}
    click(){return this.fire('click');}
    requestSubmit(){this.submission=this.fire('submit');}
  }
  const els=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element(m[1])]));
  for (const m of html.matchAll(/id="(amt-[^"]+)" data-amount="([^"]+)"/g)) els.get(m[1]).dataset.amount=m[2];
  const tabs=['tab-bridge','tab-express','tab-refuel'].map((id,i)=>{const e=els.get(id);e.dataset.mode=['quote','express','refuel'][i];return e;});
  els.get('express-mode').value='polymarket';els.get('gas-usd').value='2';els.get('include-gas').checked=true;
  const relay=mockRelay();const wallet=provider({eth_requestAccounts:()=>[USER]});const events={};wallet.on=(n,fn)=>events[n]=fn;
  // Presets can request 100 USDC; value stablecoin fixtures from their actual input.
  const fetchQuote = relay.fetchImpl;
  relay.fetchImpl = async (...args) => {
    const response = await fetchQuote(...args);
    const data = await response.json();
    const payload = JSON.parse(args[1].body);
    if (payload.originCurrency.toLowerCase() === bridgeArgsToken.toLowerCase()) {
      const units = Number(payload.amount) / 1e6;
      data.details.currencyIn.amountUsd = String(units);
      data.details.currencyOut.amountUsd = String(units * 0.99);
      data.details.currencyOut.amount = String(Math.round(Number(payload.amount) * 0.99));
    }
    return new Response(JSON.stringify(data));
  };
  const bridgeArgsToken = (await import('../docs/lib/constants.js')).CHAINS.base.tokens.USDC.address;
  const constants=await import('../docs/lib/constants.js');const context={...constants,URLSearchParams,location:{search,hash},WalletExecutor,preflight,cliCommand,webUrl,document:{getElementById:id=>els.get(id),querySelectorAll:()=>tabs,createElement:()=>new Element()},window:{ethereum:wallet},navigator:{clipboard:{writeText:async s=>{context.copied=s;}}},setInterval(fn){context.tick=fn;},getBridgeQuote:a=>getBridgeQuote(a,relay),getPolymarketOnboardPlan:a=>getPolymarketOnboardPlan(a,relay),getHyperliquidOnboardPlan:a=>getHyperliquidOnboardPlan(a,relay),planMultiWalletGasRefuel:a=>planMultiWalletGasRefuel(a,relay),statusRequests:[],checkBridgeOrderStatus:async args=>{context.statusRequests.push(args.requestId);return {status:'success'};}};
  runInNewContext(app.replace(/^import .*;\n/gm,''),context);return {els,tabs,relay,wallet,events,context};
}
test('browser connect, requote, export, execution, wallet invalidation and keyboard tabs',async()=>{
  const {els,tabs,relay,wallet,events,context}=await ui();assert.equal(wallet.calls.length,0);
  els.get('amount').value='1';await els.get('quote-form').fire('submit');assert.equal(els.get('execute').disabled,true);
  await els.get('connect').click();assert.equal(els.get('sender').value,USER);assert.equal(els.get('copy-json').disabled,true);
  await els.get('quote-form').fire('submit');assert.equal(els.get('execute').disabled,false);
  await els.get('copy-json').click();assert.equal(JSON.parse(context.copied).quotes[0].payload.user,USER);
  await els.get('copy-cli').click();assert.match(context.copied,/omniroute-bridge quote/);
  await els.get('execute').click();assert.equal(wallet.calls.filter(c=>c.method==='eth_sendTransaction').length,1);
  events.accountsChanged([]);assert.equal(els.get('execute').disabled,true);
  await tabs[0].fire('keydown',{key:'ArrowRight'});assert.equal(tabs[1].focused,true);assert.equal(els.get('express-fields').hidden,false);
  assert.deepEqual(relay.calls[0].payload.appFees,FEE);
});
test('browser express and refuel handlers select correct routes and invalidate edited plans',async()=>{
  const {els,tabs,relay}=await ui();els.get('amount').value='2';els.get('recipient').value=USER;
  await tabs[1].click();els.get('express-mode').value='both';await els.get('quote-form').fire('submit');assert.deepEqual(relay.calls.map(c=>c.payload.destinationChainId),[999,42161]);
  await tabs[2].click();els.get('recipients').value=USER+'\n'+USER;await els.get('quote-form').fire('submit');assert.equal(relay.calls.length,4);
  await els.get('quote-form').fire('input');assert.equal(els.get('copy-cli').disabled,true);assert.equal(els.get('results').children.length,0);
});
test('delivery status retains all active request IDs after input, chain and wallet changes and requotes', async () => {
  const { els, tabs, events, context } = await ui();
  els.get('amount').value = '2';
  await els.get('connect').click();
  await tabs[1].click();
  await els.get('quote-form').fire('submit');
  await els.get('execute').click();
  const expected = ['request-1', 'request-2'];
  async function check() {
    assert.equal(els.get('check-status').disabled, false);
    context.statusRequests.length = 0;
    await els.get('check-status').click();
    assert.deepEqual(context.statusRequests, expected);
    assert.equal(els.get('check-status').disabled, false);
  }
  await check();
  els.get('amount').value = '3';
  await els.get('quote-form').fire('input');
  assert.equal(els.get('execute').disabled, true);
  await check();
  els.get('from-chain').value = 'arbitrum';
  await els.get('from-chain').fire('change');
  await els.get('quote-form').fire('change');
  await check();
  events.chainChanged('0xa4b1');
  await check();
  await tabs[0].click();
  await els.get('quote-form').fire('submit');
  await check();
  context.checkBridgeOrderStatus = async () => { throw new Error('Synthetic status failure'); };
  await els.get('check-status').click();
  assert.equal(els.get('status').textContent, 'Synthetic status failure');
  assert.equal(els.get('check-status').disabled, false);
});
test('quote expiring during account checks stops before send', async () => {
  const p = await fixture(); let now = Date.now();
  const wallet = provider({ eth_accounts: () => { now += 61000; return [USER]; } });
  await assert.rejects(new WalletExecutor(wallet, { now: () => now }).execute(p, USER), /expired/);
  assert.equal(wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 0);
});
test('UI renders object symbols as Unavailable without a coercion error', async () => {
  const { els, context } = await ui();
  context.getBridgeQuote = async () => {
    const p = await fixture();
    p.quotes[0].currencyOut.symbol = { toString: 'OUT' };
    return p.quotes[0];
  };
  els.get('amount').value = '2';
  await els.get('quote-form').fire('submit');
  const walk = el => [el, ...el.children.flatMap(walk)];
  assert.ok(walk(els.get('results')).some(el => el.textContent === '9.9 Unavailable'));
  assert.equal(els.get('copy-json').disabled, false);
  assert.doesNotMatch(els.get('status').textContent, /Cannot convert object to primitive value/);
});
test('UI renders malicious API strings only as inert text and handles quote errors', async () => {
  const { els, context } = await ui();
  context.getBridgeQuote = async () => { const p = await fixture(); p.quotes[0].currencyOut.symbol = '<img src=x onerror=alert(1)>'; return p.quotes[0]; };
  els.get('amount').value = '2'; await els.get('quote-form').fire('submit');
  const walk = el => [el, ...el.children.flatMap(walk)];
  assert.ok(walk(els.get('results')).some(el => el.textContent?.includes('<img src=x onerror=alert(1)>')));
  context.getBridgeQuote = async () => { throw new Error('Synthetic HTTP failure'); };
  await els.get('quote-form').fire('submit'); assert.equal(els.get('status').textContent, 'Synthetic HTTP failure'); assert.equal(els.get('copy-json').disabled, true);
});

test('delivery status checks the loaded plan before any route is submitted', async () => {
  const { els, context } = await ui();
  els.get('amount').value = '1';
  await els.get('quote-form').fire('submit');
  await els.get('check-status').click();
  assert.deepEqual(context.statusRequests, ['request-1']);
});
for (const rejectSecond of [false, true]) {
  test(`delivery status retains submitted Plan A when Plan B is ${rejectSecond ? 'rejected by wallet' : 'submitted'}`, async () => {
    const { els, wallet, context } = await ui();
    els.get('amount').value = '1';
    await els.get('connect').click();
    await els.get('quote-form').fire('submit');
    await els.get('execute').click();
    const firstLog = els.get('progress').children[0].textContent;
    assert.match(firstLog, /0x[0-9a-f]{64}/);
    assert.match(firstLog, /Relay requestId: request-1/);
    els.get('amount').value = '2';
    await els.get('quote-form').fire('input');
    await els.get('quote-form').fire('submit');
    if (rejectSecond) {
      const request = wallet.request.bind(wallet);
      wallet.request = async req => {
        if (req.method === 'eth_sendTransaction') {
          wallet.calls.push(req);
          throw Object.assign(new Error('User rejected request'), { code: 4001 });
        }
        return request(req);
      };
    }
    await els.get('execute').click();
    assert.equal(wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 2);
    if (rejectSecond) assert.match(els.get('status').textContent, /User rejected request/);
    else assert.ok(els.get('progress').children.some(el => /0x[0-9a-f]{64} · Relay requestId: request-2/.test(el.textContent)));
    // Clear the loaded plan too: submitted routes must remain independently available.
    await els.get('quote-form').fire('input');
    assert.equal(els.get('check-status').disabled, false);
    await els.get('check-status').click();
    assert.deepEqual(context.statusRequests, rejectSecond ? ['request-1'] : ['request-1', 'request-2']);
  });
}

test('preflight validates matching origin token addresses independent of transaction target', async () => {
  const p = await fixture(), q = p.quotes[0];
  q.inputToken.address = q.payload.originCurrency.toUpperCase();
  assert.equal(preflight(p, USER).length, 1);
  q.inputToken.address = USER;
  assert.throws(() => preflight(p, USER), /Invalid transaction calldata or sender/);
  delete q.inputToken;
  assert.equal(preflight(p, USER).length, 1);
  q.payload.originCurrency = '';
  assert.throws(() => preflight(p, USER), /Invalid transaction calldata or sender/);
});
test('preflight bounds approvals to the input token, spender encoding and quoted amount', async () => {
  const base = await fixture(), q = base.quotes[0], d = q.steps[0].items[0].data;
  d.to = q.inputToken.address;
  d.data = '0x095ea7b3' + '0'.repeat(24) + USER.slice(2) + BigInt(q.payload.amount).toString(16).padStart(64, '0');
  assert.equal(preflight(base, USER).length, 1);
  for (const mutate of [
    (q,d) => { d.value = '1'; },
    (q,d) => { d.to = USER; },
    (q,d) => { d.data += '00'; },
    (q,d) => { d.data = d.data.slice(0, -2); },
    (q,d) => { d.data = d.data.slice(0, 10) + '1' + d.data.slice(11); },
    (q,d) => { d.data = d.data.slice(0, 10) + '0'.repeat(64) + d.data.slice(74); },
    (q,d) => { d.data = d.data.slice(0, 74) + (BigInt(q.payload.amount) + 1n).toString(16).padStart(64, '0'); },
    q => { q.inputToken.address = '0x' + '0'.repeat(40); }
  ]) {
    const p = structuredClone(base); mutate(p.quotes[0], p.quotes[0].steps[0].items[0].data);
    assert.throws(() => preflight(p, USER), /Invalid transaction calldata or sender/);
  }
  d.data = d.data.slice(0, 74) + '0'.repeat(64);
  assert.equal(preflight(base, USER).length, 1); // Approval reset is allowed.
});
test('preflight sums approvals and transfers across all items and steps per quote', async () => {
  for (const secondSelector of ['0x095ea7b3', '0xa9059cbb']) {
    for (const separateSteps of [false, true]) {
      const p = await fixture(), q = p.quotes[0];
      const item = q.steps[0].items[0];
      item.data.to = q.inputToken.address;
      item.data.data = '0x095ea7b3' + '0'.repeat(24) + USER.slice(2) + BigInt(q.payload.amount).toString(16).padStart(64, '0');
      const second = structuredClone(item);
      second.data.data = secondSelector + item.data.data.slice(10);
      if (separateSteps) q.steps.push({ kind: 'transaction', items: [second] });
      else q.steps[0].items.push(second);
      assert.throws(() => preflight(p, USER), /Invalid transaction calldata or sender/);
    }
  }
});
test('preflight accepts approval reset then full approval followed by router deposit', async () => {
  const p = await fixture(), q = p.quotes[0];
  const deposit = structuredClone(q.steps[0]);
  const approval = q.steps[0].items[0];
  approval.data.to = q.inputToken.address;
  approval.data.data = '0x095ea7b3' + '0'.repeat(24) + deposit.items[0].data.to.slice(2) + '0'.repeat(64);
  const fullApproval = structuredClone(q.steps[0]);
  fullApproval.items[0].data.data = approval.data.data.slice(0, 74) + BigInt(q.payload.amount).toString(16).padStart(64, '0');
  q.steps.push(fullApproval, deposit);
  assert.deepEqual(preflight(p, USER).map(({ tx }) => tx.data), [approval.data.data, fullApproval.items[0].data.data, deposit.items[0].data.data]);
});
test('preflight rejects third-party approval and permit selectors for token and native inputs', async () => {
  for (const selector of ['0x095ea7b3', '0x39509351', '0x87517c45', '0xd73dd623', '0xa22cb465', '0xd505accf']) {
    for (const native of [false, true]) {
      const p = await fixture(), q = p.quotes[0];
      if (native) q.inputToken.address = q.payload.originCurrency = '0x' + '0'.repeat(40);
      const d = q.steps[0].items[0].data;
      d.to = USER;
      d.data = selector + '0'.repeat(24) + USER.slice(2) + '1'.padStart(64, '0');
      assert.throws(() => preflight(p, USER), /Invalid transaction calldata or sender/);
    }
  }
});
test('native values are summed across incomplete steps per quote; token spends require zero value', async () => {
  const p = await fixture(), q = p.quotes[0];
  q.steps[0].items[0].data.value = '1';
  assert.throws(() => preflight(p, USER), /Invalid transaction calldata or sender/);
  q.inputToken.address = q.payload.originCurrency = '0x' + '0'.repeat(40); q.payload.amount = '10';
  q.steps[0].items[0].data.value = '6';
  q.steps.push(structuredClone(q.steps[0])); q.steps[1].items[0].data.value = '4';
  assert.equal(preflight(p, USER).length, 2);
  q.steps[1].items[0].data.value = '5';
  assert.throws(() => preflight(p, USER), /Invalid transaction calldata or sender/);
  q.steps[1].items[0].status = 'complete';
  assert.equal(preflight(p, USER).length, 1);
  p.quotes.push(structuredClone(q));
  assert.equal(preflight(p, USER).length, 2);
});
test('multi-transaction batch survives 45-second confirmations but enforces total time limit', async () => {
  for (const delay of [45000, 360000, 360001]) {
    const p = await fixture(); let now = Date.parse(p.quotes[0].quotedAt) + 30000;
    p.quotes[0].steps.push(structuredClone(p.quotes[0].steps[0]), structuredClone(p.quotes[0].steps[0]));
    let receipts = 0;
    const wallet = provider({ eth_getTransactionReceipt: () => { if (receipts++ === 0) now += delay; return { status: '0x1' }; } });
    const runner = new WalletExecutor(wallet, { now: () => now });
    if (delay > 360000) await assert.rejects(runner.execute(p, USER), /Quote expired/);
    else await runner.execute(p, USER);
    assert.equal(wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, delay > 360000 ? 1 : 3);
    assert.equal(runner.attempted.has(p), true);
  }
});
test('pre-send chain switch, account mismatch and expiry do not lock a plan', async () => {
  for (const mode of ['chain', 'account', 'expiry']) {
    const p = await fixture(); let now = Date.parse(p.quotes[0].quotedAt), chain = '0x1';
    const wallet = provider(mode === 'chain' ? { eth_chainId: () => chain, wallet_switchEthereumChain: () => { chain = '0x2105'; } } : { eth_accounts: () => { if (mode === 'expiry') now += 61000; return mode === 'account' ? [] : [USER]; } });
    const runner = new WalletExecutor(wallet, { now: () => now });
    await assert.rejects(runner.execute(p, USER), /Chain switched|account or chain changed|expired/);
    assert.equal(runner.attempted.has(p), false);
    assert.equal(wallet.calls.filter(c => c.method === 'eth_sendTransaction').length, 0);
  }
});
test('timer preserves status messages and reports expiry only when execution becomes disabled', async () => {
  const { els, context } = await ui();
  els.get('amount').value = '1'; await els.get('quote-form').fire('submit');
  els.get('status').textContent = 'Copied JSON'; context.tick();
  assert.equal(els.get('status').textContent, 'Copied JSON');
  await els.get('connect').click(); await els.get('quote-form').fire('submit');
  assert.equal(els.get('execute').disabled, false);
  context.preflight = () => { throw new Error('Quote expired. Request and review a fresh quote.'); };
  context.tick(); assert.match(els.get('status').textContent, /Quote expired/);
  assert.equal(els.get('execute').disabled, true);
  els.get('status').textContent = 'Delivery status: success'; context.tick();
  assert.equal(els.get('status').textContent, 'Delivery status: success');
});

test('input-token calls reject allowance increases, transferFrom and unbounded transfers', async () => {
  const base = await fixture(), q = base.quotes[0];
  const encode = (selector, amount) => selector + '0'.repeat(24) + USER.slice(2) + amount.toString(16).padStart(64, '0');
  const item = q.steps[0].items[0];
  item.data.to = q.inputToken.address;
  const quoted = BigInt(q.payload.amount);
  for (const selector of ['0x39509351', '0x23b872dd', '0xdeadbeef']) {
    item.data.data = encode(selector, 1n);
    assert.throws(() => preflight(base, USER), /Invalid transaction calldata or sender/);
  }
  item.data.data = encode('0xa9059cbb', quoted + 1n);
  assert.throws(() => preflight(base, USER), /Invalid transaction calldata or sender/);
  for (const amount of [1n, quoted]) {
    item.data.data = encode('0xa9059cbb', amount);
    assert.equal(preflight(base, USER).length, 1);
  }
  for (const malformed of [encode('0xa9059cbb', 1n) + '00', '0xa9059cbb' + '0'.repeat(128)]) {
    item.data.data = malformed;
    assert.throws(() => preflight(base, USER), /Invalid transaction calldata or sender/);
  }
  item.data.data = encode('0xa9059cbb', quoted / 2n);
  q.steps.push(structuredClone(q.steps[0]));
  assert.equal(preflight(base, USER).length, 2);
  q.steps[1].items[0].data.data = encode('0xa9059cbb', quoted / 2n + 1n);
  assert.throws(() => preflight(base, USER), /Invalid transaction calldata or sender/);
  q.steps[1].items[0].status = 'complete';
  assert.equal(preflight(base, USER).length, 1);
  item.data.to = USER;
  item.data.data = encode('0x39509351', 1n);
  assert.throws(() => preflight(base, USER), /Invalid transaction calldata or sender/);
});

test('bridge deep link resolves aliases, prefills inputs and fetches a fresh unsigned quote on load', async () => {
  const { els, relay, wallet, context } = await ui('?' + new URLSearchParams({ mode: 'quote', from: '8453', to: 'arb', token: 'USDC', toToken: 'ETH', amount: '12.5', sender: USER, recipient: USER, slippageBps: '50', calldata: '0xdeadbeef' }));
  await els.get('quote-form').submission;
  assert.equal(els.get('from-chain').value, 'base');
  assert.equal(els.get('to-chain').value, 'arbitrum');
  assert.equal(els.get('from-token').value, 'USDC');
  assert.equal(els.get('to-token').value, 'ETH');
  assert.equal(els.get('amount').value, '12.5');
  assert.equal(els.get('sender').value, USER);
  assert.equal(els.get('recipient').value, USER);
  assert.equal(relay.calls.length, 1);
  assert.equal(relay.calls[0].payload.amount, '12500000');
  assert.equal(relay.calls[0].payload.slippageTolerance, '50');
  assert.equal(wallet.calls.length, 0);
  assert.equal(els.get('execute').disabled, true);
  assert.equal(els.get('copy-link').disabled, false);
  await els.get('copy-link').click();
  const copied = context.copied;
  assert.equal(new URL(copied).searchParams.get('slippageBps'), '50');
  assert.equal(new URL(copied).searchParams.has('calldata'), false);
  await els.get('copy-cli').click();
  assert.match(context.copied, /--slippage-bps '50'/);
  await els.get('copy-link').click();
  assert.equal(els.get('status').textContent, 'Copied shareable route link. Opening it fetches a fresh quote.');
  const walk = el => [el, ...el.children.flatMap(walk)];
  assert.ok(walk(els.get('results')).some(el => el.textContent === 'Shareable executeUrl'));
  assert.ok(walk(els.get('results')).some(el => el.textContent === copied));
  const reopened = await ui(new URL(copied).search);
  await reopened.els.get('quote-form').submission;
  assert.equal(reopened.relay.calls.length, 1);
  await els.get('quote-form').fire('input');
  assert.equal(els.get('copy-link').disabled, true);
  await els.get('copy-link').click();
  assert.equal(context.copied, copied);
});

test('express and refuel deep links auto-submit their complete plans and copy the plan link', async () => {
  for (const [mode, extra, destinations] of [
    ['express', { expressMode: 'polymarket', includeGas: '1', gasUsd: '3' }, [137, 137]],
    ['polymarket', { includeGas: '0' }, [137]],
    ['polymarket', { includeGas: 'false' }, [137]],
    ['hyperliquid', {}, [999]],
    ['express', { expressMode: 'both' }, [999, 42161]],
    ['refuel', { to: 'polygon', recipients: `${USER},${USER}` }, [137, 137]]
  ]) {
    const { els, relay, wallet, context } = await ui('?' + new URLSearchParams({ mode, from: 'base', token: 'USDC', amount: '10', sender: USER, recipient: USER, ...extra }));
    await els.get('quote-form').submission;
    assert.deepEqual(relay.calls.map(c => c.payload.destinationChainId), destinations);
    assert.equal(wallet.calls.length, 0);
    assert.equal(els.get('copy-link').disabled, false);
    await els.get('copy-json').click();
    const plan = JSON.parse(context.copied);
    await els.get('copy-link').click();
    assert.equal(context.copied, plan.executeUrl);
    assert.equal(new URL(context.copied).searchParams.get('mode'), mode === 'refuel' ? 'refuel' : 'express');
    if (mode === 'refuel') assert.equal(els.get('recipients').value, `${USER}\n${USER}`);
    if (extra.gasUsd) { assert.equal(els.get('gas-usd').value, '3'); assert.equal(relay.calls[1].payload.amount, '3000000'); }
    if (['0', 'false'].includes(extra.includeGas)) assert.equal(els.get('include-gas').checked, false);
  }
});

test('incomplete or unsupported deep links do not auto-quote a substituted route', async () => {
  for (const query of ['', '?amount=10', '?from=base&amount=10', '?mode=quote', '?mode=refuel&amount=1', '?mode=quote&amount=1&from=unknown', '?mode=quote&amount=1&token=0xdeadbeef', '?mode=quote&amount=1&slippageBps=oops', '?mode=__proto__&amount=1', '?mode=unknown&amount=1', '?mode=express&amount=1&expressMode=unknown']) {
    const { els, relay, wallet } = await ui(query);
    assert.equal(els.get('quote-form').submission, undefined);
    assert.equal(relay.calls.length, 0);
    assert.equal(wallet.calls.length, 0);
  }
});

test('chain changes preserve the connected account and label; account changes update sender without reconnecting', async () => {
  const { els, events, wallet, context } = await ui();
  els.get('amount').value = '1';
  await els.get('connect').click();
  await els.get('quote-form').fire('submit');
  const label = els.get('connect').textContent;
  events.chainChanged('0xa4b1');
  assert.equal(els.get('connect').textContent, label);
  assert.equal(els.get('sender').value, USER);
  assert.equal(els.get('execute').disabled, true);
  assert.equal(els.get('copy-link').disabled, true);
  assert.equal(els.get('status').textContent, 'Wallet network changed. Request a fresh quote.');
  await els.get('quote-form').fire('submit');
  assert.equal(els.get('execute').disabled, false); // preflight requires retained account.
  const next = '0x2222222222222222222222222222222222222222';
  events.accountsChanged([next]);
  assert.equal(els.get('sender').value, next);
  assert.equal(els.get('connect').textContent, next.slice(0,6) + '…' + next.slice(-4));
  assert.equal(els.get('execute').disabled, true);
  assert.equal(els.get('status').textContent, 'Wallet account changed. Request a fresh quote with this sender.');
  await els.get('quote-form').fire('submit');
  assert.equal(els.get('execute').disabled, false);
  await els.get('copy-json').click();
  assert.equal(JSON.parse(context.copied).quotes[0].payload.user, next);
  assert.equal(wallet.calls.filter(c => c.method === 'eth_requestAccounts').length, 1);
  for (const disconnect of [() => events.accountsChanged([]), () => events.disconnect()]) {
    disconnect();
    assert.equal(els.get('connect').textContent, 'Connect wallet');
    const sender = els.get('sender').value;
    events.accountsChanged([next]);
    assert.equal(els.get('sender').value, sender);
    assert.equal(els.get('connect').textContent, 'Connect wallet');
    assert.equal(els.get('execute').disabled, true);
    await els.get('quote-form').fire('submit');
    assert.equal(els.get('execute').disabled, true);
    await els.get('connect').click();
  }
});

test('webUrl maps current form arguments to shareable route intent', () => {
  const url = new URL(webUrl('refuel', { fromChain: 'base', fromToken: 'USDC', targetChain: 'polygon', amountPerWallet: '1', recipients: [USER, USER], senderAddress: USER, data: '0xdeadbeef' }));
  assert.deepEqual(Object.fromEntries(url.searchParams), { mode: 'refuel', from: 'base', to: 'polygon', token: 'USDC', amount: '1', sender: USER, recipients: `${USER},${USER}` });
  const poly = new URL(webUrl('polymarket', { ...bridgeArgs, includeGasTopup: false, gasTopupAmountUsd: '2' }));
  assert.equal(poly.searchParams.get('expressMode'), 'polymarket');
  assert.equal(poly.searchParams.get('includeGas'), '0');
  assert.equal(poly.searchParams.has('gasUsd'), false);
});

const routeQuery = extra => '?' + new URLSearchParams({ mode: 'quote', from: 'base', to: 'arbitrum', token: 'USDC', amount: '10', ...extra });
test('wallet connection, account switch and disconnect clear link slippage and replace browser history', async () => {
  for (const action of ['connect', 'switch', 'accounts-disconnect', 'provider-disconnect']) {
    const { els, relay, events, context } = await ui(routeQuery({ slippageBps: '50' }));
    await els.get('quote-form').submission;
    assert.equal(relay.calls[0].payload.slippageTolerance, '50');
    if (action !== 'connect') {
      await els.get('connect').click();
      // Restore a link-derived tolerance to isolate the account event from connection clearing.
      runInNewContext('slippageBps = 50;', context);
    }
    const replacements = [];
    context.location.pathname = '/omniroute-bridge-mcp/';
    context.history = { replaceState: (...args) => replacements.push(args) };
    if (action === 'connect') await els.get('connect').click();
    else if (action === 'switch') events.accountsChanged(['0x2222222222222222222222222222222222222222']);
    else if (action === 'accounts-disconnect') events.accountsChanged([]);
    else events.disconnect();
    assert.deepEqual(replacements, [[null, '', '/omniroute-bridge-mcp/']], action);
    assert.equal(runInNewContext('slippageBps', context), undefined, action);
    await els.get('quote-form').fire('submit');
    assert.equal('slippageTolerance' in relay.calls.at(-1).payload, false, action);
    assert.equal(walletSends(context), 0);
  }
  function walletSends(context) { return context.window.ethereum.calls.filter(c => c.method === 'eth_sendTransaction').length; }
});
const routeCards = els => els.get('results').children.filter(el => el.className === 'card');
const reviewRows = card => {
  const rows = card.children.find(el => el.children.some(child => child.textContent === 'Source amount')).children;
  return Object.fromEntries(rows.filter((_, i) => i % 2 === 0).map((el, i) => [el.textContent, rows[i * 2 + 1].textContent]));
};
test('deep-link slippage is visible and every manual form control clears it', async () => {
  for (const action of ['input', 'change', 'tab-express', 'tab-refuel', 'amt-01', 'amt-1', 'amt-25', 'amt-100', 'amt-500', 'preset-polymarket', 'preset-hyperliquid', 'preset-solana']) {
    const { els, relay } = await ui(routeQuery({ slippageBps: '50' }));
    await els.get('quote-form').submission;
    assert.equal(relay.calls[0].payload.slippageTolerance, '50');
    assert.equal(reviewRows(routeCards(els)[0])['Slippage tolerance'], '50 bps (0.50%)');
    if (['input', 'change'].includes(action)) {
      els.get('amount').value = '2';
      await els.get('quote-form').fire(action);
    } else {
      await els.get(action).click();
      await els.get('quote-form').submission;
      if (action.startsWith('tab-') || action.startsWith('preset-')) {
        await els.get('tab-bridge').click();
      }
    }
    await els.get('quote-form').fire('submit');
    assert.ok(relay.calls.slice(1).every(c => !('slippageTolerance' in c.payload)), action);
    for (const card of routeCards(els)) assert.equal(reviewRows(card)['Slippage tolerance'], 'Auto (Relay default)', action);
  }
});
test('invalid deep-link slippage blocks auto-submit and never leaks into manual quotes', async () => {
  for (const slippageBps of ['501', '10000', 'oops']) {
    const { els, relay } = await ui(routeQuery({ slippageBps }));
    assert.equal(els.get('quote-form').submission, undefined);
    assert.equal(relay.calls.length, 0);
    assert.match(els.get('status').textContent, /unsupported/);
    await els.get('quote-form').fire('submit');
    assert.equal(relay.calls.length, 1);
    assert.equal('slippageTolerance' in relay.calls[0].payload, false);
    assert.equal(reviewRows(routeCards(els)[0])['Slippage tolerance'], 'Auto (Relay default)');
  }
  const { els, relay } = await ui(routeQuery({ slippageBps: '500' }));
  await els.get('quote-form').submission;
  assert.equal(relay.calls[0].payload.slippageTolerance, '500');
});
test('custom link recipients require manual review and each affected route shows a warning', async () => {
  const other = '0x000000000000000000000000000000000000dEaD';
  for (const extra of [{ sender: USER, recipient: other }, { recipient: other }, { mode: 'refuel', sender: USER, recipients: `${USER},${other}` }, { mode: 'refuel', recipients: other }]) {
    const { els, relay, wallet } = await ui(routeQuery(extra));
    assert.equal(els.get('sender').value, extra.sender ?? '');
    assert.equal(els.get('recipient').value, extra.recipient ?? '');
    assert.equal(els.get('recipients').value, extra.recipients?.replaceAll(',', '\n') ?? '');
    assert.equal(els.get('amount').value, '10');
    assert.equal(els.get('quote-form').submission, undefined);
    assert.equal(relay.calls.length, 0);
    assert.match(els.get('status').textContent, /Custom recipient detected in link/);
    await els.get('quote-form').fire('submit');
    const cards = routeCards(els);
    assert.equal(cards.length, extra.recipients?.split(',').length ?? 1);
    cards.forEach((card, i) => {
      const warning = relay.calls[i].payload.recipient.toLowerCase() !== relay.calls[i].payload.user.toLowerCase();
      assert.equal(reviewRows(card)['Recipient warning'], warning ? 'Differs from sender / connected wallet — verify before signing' : undefined);
      assert.equal(card.children.some(el => el.className === 'notice note' && el.textContent === 'Warning: Recipient differs from sender or connected wallet. Verify the recipient address before signing.'), warning);
    });
    assert.equal(wallet.calls.length, 0);
  }
});
test('recipient review also checks the connected wallet and compares addresses case insensitively for EVM and case sensitively for Solana', async () => {
  const other = '0x000000000000000000000000000000000000dEaD';
  const { els } = await ui(routeQuery({ sender: other, recipient: other.toLowerCase() }));
  await els.get('quote-form').submission;
  assert.equal(reviewRows(routeCards(els)[0])['Recipient warning'], undefined);
  await els.get('connect').click();
  els.get('sender').value = other;
  await els.get('quote-form').fire('input');
  await els.get('quote-form').fire('submit');
  assert.match(reviewRows(routeCards(els)[0])['Recipient warning'], /connected wallet/);
  const solA = 'FJCcoqJHmoJyuthUY773gnxBsAY8yQuAgfYwL3zETVVW';
  const solB = 'fJCcoqJHmoJyuthUY773gnxBsAY8yQuAgfYwL3zETVVW';
  const sol = await ui('?' + new URLSearchParams({ mode: 'quote', from: 'solana', to: 'solana', token: 'SOL', toToken: 'USDC', amount: '1', sender: solA, recipient: solB }));
  assert.equal(sol.els.get('quote-form').submission, undefined);
  assert.match(sol.els.get('status').textContent, /Custom recipient detected in link/);
});
test('fragment deep links load routes, search takes precedence, and explicit chain pairs auto-quote', async () => {
  for (const prefix of ['#', '#?']) {
    const { els, relay } = await ui('', prefix + routeQuery({ slippageBps: '50' }).slice(1));
    await els.get('quote-form').submission;
    assert.equal(relay.calls.length, 1);
    assert.equal(relay.calls[0].payload.slippageTolerance, '50');
    assert.equal(els.get('to-chain').value, 'arbitrum');
  }
  const blocked = await ui('?amount=10', '#mode=quote&amount=10');
  assert.equal(blocked.relay.calls.length, 0);
  const explicit = await ui('?from=base&to=arbitrum&amount=10');
  await explicit.els.get('quote-form').submission;
  assert.equal(explicit.relay.calls.length, 1);
});
test('submit uses webUrl when the quote has no executeUrl', async () => {
  const { els, context } = await ui();
  const quote = context.getBridgeQuote;
  context.getBridgeQuote = async input => { const result = await quote(input); delete result.executeUrl; return result; };
  els.get('amount').value = '2';
  await els.get('quote-form').fire('submit');
  await els.get('copy-link').click();
  assert.equal(new URL(context.copied).searchParams.get('amount'), '2');
});
