import { CHAINS, resolveChain, formatUnits } from './lib/constants.js';
import { getBridgeQuote, getPolymarketOnboardPlan, getHyperliquidOnboardPlan, planMultiWalletGasRefuel, checkBridgeOrderStatus } from './lib/service.js';
import { WalletExecutor, preflight, cliCommand, webUrl } from './lib/wallet.js';
const $ = id => document.getElementById(id);
let mode = 'quote', version = 0, plan, checkingStatus = false, command, account, executor, quoting = false, executing = false, reviewedVersion;
let slippageBps;
const submittedQuotes = [];
const show = message => { $('status').textContent = message; };
function invalidate(message = 'Inputs changed. Request a fresh quote.') {
  version++; plan = undefined;
  for (const id of ['execute', 'copy-json', 'copy-cli', 'copy-link']) $(id).disabled = true;
  $('check-status').disabled = checkingStatus || submittedQuotes.length === 0;
  $('results').replaceChildren(); show(message);
}
function options(id, values, chosen) { $(id).replaceChildren(...values.map(([value, label]) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; })); if (chosen) $(id).value = chosen; }
function tokens(side) { options(side + '-token', Object.values(CHAINS[$(side + '-chain').value].tokens).filter((t,i,a) => a.findIndex(v => v.address === t.address) === i).map(t => [t.symbol, t.symbol])); }
for (const side of ['from', 'to']) { options(side + '-chain', Object.values(CHAINS).map(c => [c.slug, c.slug === 'hyperevm' ? 'HyperEVM' : c.slug[0].toUpperCase() + c.slug.slice(1)]), side === 'from' ? 'base' : 'arbitrum'); tokens(side); $(side + '-chain').addEventListener('change', () => tokens(side)); }
function presentation() {
  $('destination').hidden = mode === 'express'; $('to-token-label').hidden = mode === 'refuel'; $('express-fields').hidden = mode !== 'express'; $('recipient-label').hidden = mode === 'refuel'; $('recipients-label').hidden = mode !== 'refuel';
  const poly = $('express-mode').value === 'polymarket'; $('gas-fields').hidden = !poly;
  $('express-note').textContent = poly ? 'USDC.e arrives at your Polygon wallet. Verify your Polymarket wallet; setup, approvals and platform deposits remain separate. POL uses an additional source-token budget.' : 'HYPE on HyperEVM is separate from Hyperliquid L1 collateral. Arbitrum USDC needs an official Hyperliquid deposit and ETH for gas. Both spends the full input twice.';
  $('form-title').textContent = mode === 'quote' ? 'Build your route' : mode === 'express' ? 'Fund your next position' : 'Gas for every wallet';
  $('budget').textContent = mode === 'refuel' ? 'Amount is source-token input PER wallet. Duplicate recipients receive multiple allocations. Batch execution is not atomic.' : mode === 'express' && $('express-mode').value === 'both' ? 'Two routes × the full source amount. Total budget is doubled, plus network gas.' : 'Amounts are in source-token units; source network gas is additional.';
}
const sameAddr = (a, b) => Boolean(a && b && (/^0x/i.test(a) && /^0x/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b));
const clearSlippage = () => { if (slippageBps !== undefined) { slippageBps = undefined; globalThis.history?.replaceState?.(null, '', globalThis.location?.pathname ?? '/'); } };
const tabs = [...document.querySelectorAll('[role=tab]')];
for (const tab of tabs) {
  tab.addEventListener('click', () => { if (executing) return; clearSlippage(); mode = tab.dataset.mode; for (const t of tabs) { t.setAttribute('aria-selected', String(t === tab)); t.tabIndex = t === tab ? 0 : -1; } $('workspace').setAttribute('aria-labelledby', tab.id); invalidate(); presentation(); });
  tab.addEventListener('keydown', e => { const i = tabs.indexOf(tab); const next = e.key === 'ArrowRight' ? (i+1)%3 : e.key === 'ArrowLeft' ? (i+2)%3 : e.key === 'Home' ? 0 : e.key === 'End' ? 2 : -1; if (next >= 0) { e.preventDefault(); tabs[next].focus(); tabs[next].click(); } });
}
$('quote-form').addEventListener('input', () => { clearSlippage(); invalidate(); presentation(); });
$('quote-form').addEventListener('change', () => { clearSlippage(); invalidate(); presentation(); });
for (const id of ['amt-01', 'amt-1', 'amt-25', 'amt-100', 'amt-500']) {
  $(id).addEventListener('click', () => {
    if (executing) return;
    clearSlippage();
    $('amount').value = $(id).dataset.amount;
    invalidate(); presentation();
  });
}
for (const preset of ['polymarket', 'hyperliquid', 'solana']) {
  $('preset-' + preset).addEventListener('click', () => {
    if (quoting || executing) return;
    clearSlippage();
    $(preset === 'solana' ? 'tab-bridge' : 'tab-express').click();
    $('from-chain').value = preset === 'solana' ? 'solana' : 'base';
    tokens('from');
    $('from-token').value = preset === 'polymarket' ? 'USDC' : preset === 'hyperliquid' ? 'ETH' : 'SOL';
    $('amount').value = preset === 'polymarket' ? '100' : preset === 'hyperliquid' ? '0.05' : '1';
    if (preset === 'solana') {
      if (account && $('sender').value.trim().toLowerCase() === account.toLowerCase()) $('sender').value = '';
      $('to-chain').value = 'base'; tokens('to'); $('to-token').value = 'USDC';
    } else {
      if (account && !$('sender').value.trim()) $('sender').value = account;
      $('express-mode').value = preset === 'polymarket' ? 'polymarket' : 'hyperevm_hype';
      if (preset === 'polymarket') { $('include-gas').checked = true; $('gas-usd').value = '2'; }
    }
    invalidate(); presentation();
    $('quote-form').requestSubmit();
  });
}
function args() {
  const common = { fromChain: $('from-chain').value, fromToken: $('from-token').value, amount: $('amount').value.trim(), userAddress: $('sender').value.trim() || undefined, recipientAddress: $('recipient').value.trim() || undefined };
  if (mode === 'quote') return ['quote', { ...common, toChain: $('to-chain').value, toToken: $('to-token').value, ...(slippageBps === undefined ? {} : { slippageBps }) }];
  if (mode === 'refuel') return ['refuel', { fromChain: common.fromChain, fromToken: common.fromToken, senderAddress: common.userAddress, targetChain: $('to-chain').value, amountPerWallet: common.amount, recipients: $('recipients').value.split(/[\n,]/).map(s => s.trim()).filter(Boolean) }];
  return $('express-mode').value === 'polymarket' ? ['polymarket', { ...common, includeGasTopup: $('include-gas').checked, gasTopupAmountUsd: $('gas-usd').value.trim() }] : ['hyperliquid', { ...common, targetMode: $('express-mode').value }];
}
const text = (tag, value, parent) => { const el = document.createElement(tag); el.textContent = value; parent.append(el); return el; };
const available = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' ? String(value) : 'Unavailable';
function render() {
  const root = $('results'); root.replaceChildren();
  text('p', plan.previewOnly ? 'PREVIEW ONLY · connect and requote before execution' : 'Unsigned plan · review every route below', root).className = 'notice note';
  const total = plan.quotes.reduce((sum, q) => sum + BigInt(q.payload.amount), 0n);
  text('p', `Total source input: ${formatUnits(total, plan.quotes[0].inputToken.decimals)} ${plan.quotes[0].inputToken.symbol} + source network gas`, root);
  if (plan.kind === 'gas-refuel') {
    text('p', `Aggregate quoted fees (USD): ${available(plan.totalUsdFees)} · Sequential estimate (seconds): ${available(plan.estimatedCompletionTimeSeconds)}`, root).className = 'note';
  }
  for (const note of plan.notes ?? []) text('p', note, root).className = 'note';
  plan.quotes.forEach((q, i) => {
    const card = text('article', '', root); card.className = 'card'; text('h3', `${i+1}. ${q.originChain.slug} → ${q.destinationChain.slug}`, card);
    const recipientWarning = !sameAddr(q.payload.recipient, q.payload.user) || Boolean(account && !sameAddr(q.payload.recipient, account));
    if (recipientWarning) text('p', 'Warning: Recipient differs from sender or connected wallet. Verify the recipient address before signing.', card).className = 'notice note';
    const dl = text('dl', '', card);
    for (const [key, value] of Object.entries({ 'Source amount': `${formatUnits(q.payload.amount, q.inputToken.decimals)} ${q.inputToken.symbol}`, 'Output': `${available(q.currencyOut.amountFormatted)} ${available(q.currencyOut.symbol)}`, 'Output USD': available(q.currencyOut.amountUsd), 'Minimum output': available(q.currencyOut.minimumAmountFormatted), 'Rate': available(q.rate), 'Price impact (%)': available(q.totalImpactPercent), 'Estimate (seconds)': available(q.timeEstimateSeconds), 'Network fee (USD)': available(q.fees.gasUsd), 'Relay fee (USD)': available(q.fees.relayerUsd), 'Integrator fee (USD)': available(q.fees.appFeeUsd), 'Slippage tolerance': q.payload.slippageTolerance !== undefined ? `${q.payload.slippageTolerance} bps (${(Number(q.payload.slippageTolerance) / 100).toFixed(2)}%)` : 'Auto (Relay default)', 'Recipient': q.payload.recipient, ...(recipientWarning ? { 'Recipient warning': 'Differs from sender / connected wallet — verify before signing' } : {}) })) { text('dt', key, dl); text('dd', value, dl); }
    const details = text('details', '', card); text('summary', 'Review raw unsigned steps', details); text('pre', JSON.stringify(q.steps, null, 2), details);
  });
  const details = text('details', '', root); text('summary', 'Unsigned JSON / CLI (manual copy fallback)', details); text('pre', JSON.stringify(plan, null, 2), details); text('pre', command, details); text('p', 'Shareable executeUrl', details); text('pre', plan.executeUrl, details);
}
function refreshExecution(timer = false) {
  if (!plan || executing) { $('execute').disabled = true; return; }
  const wasEnabled = !$('execute').disabled;
  try { if (!executor) throw new Error('Connect wallet and request a fresh quote to execute.'); preflight(plan, account); $('execute').disabled = false; }
  catch (e) { $('execute').disabled = true; if (!timer || wasEnabled) show(e.message); }
}
$('quote-form').addEventListener('submit', async e => {
  e.preventDefault(); if (quoting || executing) return;
  invalidate('Fetching live Relay quotes…'); const stamp = version; quoting = true; $('quote').disabled = true;
  try {
    const [kind, input] = args();
    const result = await ({ quote: getBridgeQuote, polymarket: getPolymarketOnboardPlan, hyperliquid: getHyperliquidOnboardPlan, refuel: planMultiWalletGasRefuel }[kind])(input);
    if (version !== stamp) return;
    plan = result.quotes ? result : { quotes: [result], previewOnly: result.previewOnly, executeUrl: result.executeUrl }; plan.executeUrl ??= webUrl(kind, input); reviewedVersion = stamp; command = cliCommand(kind, input); render();
    for (const id of ['copy-json', 'copy-cli', 'copy-link']) $(id).disabled = false;
    $('check-status').disabled = checkingStatus;
    show('Quote ready. Review amounts, recipients and raw steps.'); refreshExecution();
  } catch (error) { if (version === stamp) show(error.message); }
  finally { quoting = false; $('quote').disabled = false; }
});
$('connect').addEventListener('click', async () => {
  if (executing) return; clearSlippage(); $('connect').disabled = true;
  try {
    const provider = window.ethereum; if (!provider?.request) throw new Error('No injected EIP-1193 wallet found. Use unsigned export or install a wallet.');
    const accounts = await provider.request({ method: 'eth_requestAccounts' }); if (!accounts[0]) throw new Error('No wallet account selected.'); account = accounts[0];
    if (!executor) {
      executor = new WalletExecutor(provider);
      const disconnected = () => { clearSlippage(); account = undefined; $('connect').textContent = 'Connect wallet'; invalidate('Wallet changed. Connect again and request a fresh quote.'); };
      provider.on?.('accountsChanged', nextAccounts => {
        clearSlippage();
        if (!nextAccounts?.[0]) { disconnected(); return; }
        if (!account) return;
        account = nextAccounts[0]; $('sender').value = account; $('connect').textContent = account.slice(0,6) + '…' + account.slice(-4);
        invalidate('Wallet account changed. Request a fresh quote with this sender.');
      });
      provider.on?.('chainChanged', () => invalidate('Wallet network changed. Request a fresh quote.'));
      provider.on?.('disconnect', disconnected);
    }
    $('sender').value = account; $('connect').textContent = account.slice(0,6) + '…' + account.slice(-4); invalidate('Wallet connected. Request a fresh quote with this sender.');
  } catch (error) { show(error.message); } finally { $('connect').disabled = false; }
});
$('execute').addEventListener('click', async () => {
  if (executing || !plan || !executor) return;
  const current = plan, stamp = reviewedVersion; executing = true; $('execute').disabled = true; $('quote').disabled = true; $('connect').disabled = true;
  try { await executor.execute(current, account, { valid: () => stamp === version, progress: event => {
    const quote = current.quotes[event.quoteIndex];
    if (event.hash && !submittedQuotes.includes(quote)) submittedQuotes.push(quote);
    $('check-status').disabled = checkingStatus || (!submittedQuotes.length && !plan);
    text('p', `Route ${event.quoteIndex+1}: ${event.status} · ${event.hash} · Relay requestId: ${quote.requestId ?? 'Unavailable'}`, $('progress')).className = 'note address';
  } }); show('Source transactions confirmed. Check delivery status for each route.'); }
  catch (error) { show(error.message); }
  finally { executing = false; $('quote').disabled = false; $('connect').disabled = false; }
});
for (const [id, value] of [['copy-json', () => JSON.stringify(plan, null, 2)], ['copy-cli', () => command]]) $(id).addEventListener('click', async () => { if (!plan) return; try { await navigator.clipboard.writeText(value()); show('Copied. Export does not sign or broadcast.'); } catch { show('Clipboard unavailable. Select and copy from the unsigned JSON / CLI section.'); } });
$('copy-link').addEventListener('click', async () => {
  if (!plan) return;
  try { await navigator.clipboard.writeText(plan.executeUrl); show('Copied shareable route link. Opening it fetches a fresh quote.'); }
  catch { show('Clipboard unavailable. Select and copy from the unsigned JSON / CLI section.'); }
});
$('check-status').addEventListener('click', async () => {
  const quotes = submittedQuotes.length ? [...submittedQuotes] : plan?.quotes; if (!quotes || checkingStatus) return; checkingStatus = true; $('check-status').disabled = true;
  try { for (const [i, q] of quotes.entries()) { const result = q.requestId ? await checkBridgeOrderStatus({ requestId: q.requestId }) : { status: 'No Relay request ID available' }; text('p', `Route ${i+1} delivery: ${JSON.stringify(result)}`, $('progress')).className = 'note address'; } }
  catch (e) { show(e.message); } finally { checkingStatus = false; $('check-status').disabled = !submittedQuotes.length && !plan; }
});
setInterval(() => { if (plan && !executing && !executor?.attempted.has(plan)) refreshExecution(true); }, 1000);
presentation();

const rawSearch = globalThis.location?.search || (globalThis.location?.hash?.includes('=') ? globalThis.location.hash.replace(/^#\??/, '?') : '');
if (rawSearch) {
  const params = new URLSearchParams(rawSearch);
  const tab = { quote: 'tab-bridge', express: 'tab-express', polymarket: 'tab-express', hyperliquid: 'tab-express', refuel: 'tab-refuel' }[params.get('mode')];
  if (typeof tab === 'string') $(tab).click();
  let unsupported = params.has('mode') && typeof tab !== 'string';
  for (const [side, chainKey, tokenKey] of [['from', 'from', 'token'], ['to', 'to', 'toToken']]) {
    if (params.has(chainKey)) {
      try { $(side + '-chain').value = resolveChain(params.get(chainKey)).slug; tokens(side); }
      catch { unsupported = true; }
    }
    if (params.has(tokenKey)) {
      const value = params.get(tokenKey);
      if ([...$(side + '-token').children].some(option => option.value === value)) $(side + '-token').value = value;
      else unsupported = true;
    }
  }
  for (const key of ['amount', 'sender', 'recipient']) if (params.has(key)) $(key).value = params.get(key);
  if (params.has('recipients')) $('recipients').value = params.get('recipients').replaceAll(',', '\n');
  const expressMode = params.get('expressMode') ?? ({ polymarket: 'polymarket', hyperliquid: 'hyperevm_hype' }[params.get('mode')]);
  if (expressMode) {
    if (['polymarket', 'hyperevm_hype', 'arbitrum_usdc', 'both'].includes(expressMode)) $('express-mode').value = expressMode;
    else unsupported = true;
  }
  if (params.has('includeGas')) $('include-gas').checked = !['0', 'false'].includes(params.get('includeGas'));
  if (params.has('gasUsd')) $('gas-usd').value = params.get('gasUsd');
  if (params.has('slippageBps')) {
    const value = params.get('slippageBps');
    if (/^\d+$/.test(value) && Number(value) <= 500) slippageBps = Number(value);
    else unsupported = true;
  }
  const linkSender = params.get('sender')?.trim(), linkRecipient = params.get('recipient')?.trim();
  const refuelRecipients = $('recipients').value.split(/\n/).map(s => s.trim()).filter(Boolean);
  const customRecipient = (mode !== 'refuel' && Boolean(linkRecipient) && !sameAddr(linkRecipient, linkSender)) || (mode === 'refuel' && refuelRecipients.some(r => !sameAddr(r, linkSender)));
  invalidate(); presentation();
  if (unsupported) show('This route contains an unsupported chain, token or route parameter. Review the inputs before requesting a quote.');
  else if (customRecipient) show('Custom recipient detected in link (differs from sender). Verify the recipient address before requesting a quote.');
  else if ((params.has('mode') || (params.has('from') && params.has('to'))) && $('amount').value.trim() && (mode !== 'refuel' || $('recipients').value.trim())) $('quote-form').requestSubmit();
}
