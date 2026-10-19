import { CHAINS, DEFAULT_FEE_RECIPIENT, DEFAULT_SOLANA_FEE_RECIPIENT, DEFAULT_FEE_BPS, DEFAULT_EVM_USER, DEFAULT_SOLANA_USER, resolveChain, resolveToken, parseUnits, formatUnits } from './constants.js';
import { buildQuotePayload, fetchRelayQuote, fetchTransactionStatus, validateAddress } from './relay.js';
export function listSupportedRoutes({ chain } = {}) {
  return { chains: chain === undefined ? Object.values(CHAINS) : [resolveChain(chain)], presets: { polymarket: { chainId: 137, token: 'USDC.e', gasToken: 'POL' }, hyperliquid: { hyperevm_hype: { chainId: 999, token: 'HYPE' }, arbitrum_usdc: { chainId: 42161, token: 'USDC' } }, gasRefuel: { maxRecipients: 20, amountUnit: 'source token per wallet' } }, integratorFee: { recipient: DEFAULT_FEE_RECIPIENT, solanaRecipient: DEFAULT_SOLANA_FEE_RECIPIENT, bps: DEFAULT_FEE_BPS, percent: '0.30%', disclosure: 'Free software and no API key; network, Relay and integrator fees apply.' } };
}
export async function getBridgeQuote({ fromChain, toChain, fromToken = 'native', toToken = 'native', amount, userAddress, recipientAddress, slippageBps, fromTokenDecimals, toTokenDecimals }, options = {}) {
  const from = resolveChain(fromChain), to = resolveChain(toChain);
  const input = resolveToken(from, fromToken, fromTokenDecimals), output = resolveToken(to, toToken, toTokenDecimals);
  const payload = buildQuotePayload({ originChain: from, destinationChain: to, originToken: input, destinationToken: output, amountRaw: parseUnits(amount, input.decimals), user: userAddress, recipient: recipientAddress, slippageTolerance: slippageBps, feeRecipient: options.feeRecipient, feeBps: options.feeBps });
  const quote = await fetchRelayQuote(payload, options);
  const placeholders = [DEFAULT_EVM_USER.toLowerCase(), DEFAULT_SOLANA_USER];
  const previewOnly = !userAddress || placeholders.includes(payload.user.toLowerCase()) || placeholders.includes(payload.recipient.toLowerCase()) || (from.vmType !== to.vmType && !recipientAddress);
  return { ...quote, previewOnly, execution: previewOnly ? 'Preview only: request a new quote with real sender and recipient before signing.' : 'Unsigned plan: review and sign every required step in order. Requote before execution.', inputToken: input, outputToken: output };
}
function plan(kind, quotes, notes = []) {
  return { kind, quotes, previewOnly: quotes.some(q => q.previewOnly), notes, steps: quotes.flatMap((q, quoteIndex) => q.steps.map(step => ({ ...step, quoteIndex }))) };
}
export async function getPolymarketOnboardPlan({ fromChain, fromToken = 'native', amount, recipientAddress, userAddress, includeGasTopup = true, gasTopupAmountUsd = 2 }, options = {}) {
  if (typeof includeGasTopup !== 'boolean') throw new Error('includeGasTopup must be a boolean');
  if (!/^(\d+)(\.\d+)?$/.test(String(gasTopupAmountUsd)) || !Number.isFinite(Number(gasTopupAmountUsd))) throw new Error('gasTopupAmountUsd must be a non-negative decimal');
  const args = { fromChain, fromToken, amount, recipientAddress, userAddress, toChain: 'polygon' };
  const primary = await getBridgeQuote({ ...args, toToken: 'USDC.e' }, options);
  const quotes = [primary];
  if (includeGasTopup && Number(gasTopupAmountUsd) > 0) {
    // Value the source token from the primary quote, never treat ETH/SOL units as USD.
    const amountUsd = primary.currencyIn.amountUsd;
    if (amountUsd == null || !/^\d+(\.\d+)?$/.test(String(amountUsd)) || !/[1-9]/.test(String(amountUsd))) throw new Error('Primary quote amountUsd must be a positive decimal');
    const fracLen = value => (String(value).split('.')[1] ?? '').length;
    const usdScale = Math.max(18, fracLen(amountUsd), fracLen(gasTopupAmountUsd));
    const sourceUsd = parseUnits(amountUsd, usdScale);
    const targetUsd = parseUnits(gasTopupAmountUsd, usdScale);
    const raw = (BigInt(primary.payload.amount) * targetUsd + sourceUsd - 1n) / sourceUsd;
    quotes.push(await getBridgeQuote({ ...args, amount: formatUnits(raw, primary.inputToken.decimals), toToken: 'POL' }, options));
  }
  return plan('polymarket', quotes, ['Gas top-up is an additional source-token spend, valued approximately in USD; output POL is after fees.', 'USDC.e arrives at the specified Polygon wallet. Use the correct Polymarket wallet; account setup, approvals and deposits may still be required.']);
}
export async function getHyperliquidOnboardPlan({ fromChain, fromToken = 'native', amount, targetMode = 'hyperevm_hype', recipientAddress, userAddress }, options = {}) {
  if (!['hyperevm_hype', 'arbitrum_usdc', 'both'].includes(targetMode)) throw new Error('targetMode must be hyperevm_hype, arbitrum_usdc or both');
  const targets = targetMode === 'both' ? ['hyperevm_hype', 'arbitrum_usdc'] : [targetMode];
  const quotes = await Promise.all(targets.map(mode => getBridgeQuote({ fromChain, fromToken, amount, recipientAddress, userAddress, toChain: mode === 'hyperevm_hype' ? 'hyperevm' : 'arbitrum', toToken: mode === 'hyperevm_hype' ? 'HYPE' : 'USDC' }, options)));
  return plan('hyperliquid', quotes, ['Each selected route spends the full input amount; both means twice the input.', 'HyperEVM HYPE is separate from Hyperliquid L1 trading collateral. Arbitrum USDC still needs an official Hyperliquid deposit and Arbitrum ETH for gas.']);
}
function sumUsd(values) {
  if (values.some(v => v == null)) return null;
  const scale = Math.max(0, ...values.map(v => (String(v).split('.')[1] ?? '').length));
  if (scale > 255 || values.some(v => !/^\d+(\.\d+)?$/.test(String(v)))) return null;
  return formatUnits(values.reduce((sum, value) => sum + BigInt(String(value).replace('.', '').padEnd(String(value).replace('.', '').length + scale - (String(value).split('.')[1] ?? '').length, '0')), 0n), scale);
}
export async function planMultiWalletGasRefuel({ fromChain, fromToken = 'native', targetChain, amountPerWallet, recipients, senderAddress }, options = {}) {
  const target = resolveChain(targetChain), source = resolveChain(fromChain), input = resolveToken(source, fromToken);
  if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > 20) throw new Error('Provide 1 to 20 recipient addresses');
  recipients.forEach(address => validateAddress(address, target, 'Recipient'));
  if (senderAddress !== undefined) validateAddress(senderAddress, source, 'Sender');
  const raw = parseUnits(amountPerWallet, input.decimals);
  // Bounded concurrency avoids firing twenty requests at a public endpoint simultaneously.
  const quotes = new Array(recipients.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, recipients.length) }, async () => { while (next < recipients.length) { const i = next++; quotes[i] = await getBridgeQuote({ fromChain, fromToken, toChain: target.slug, toToken: 'native', amount: amountPerWallet, recipientAddress: recipients[i], userAddress: senderAddress }, options); } }));
  return { ...plan('gas-refuel', quotes, ['amountPerWallet is source-token input, not destination gas output.', 'Execute in the returned order; the batch is not atomic. Never resend already submitted steps.']), recipients, totalInputRaw: (raw * BigInt(recipients.length)).toString(), totalInputAmount: formatUnits(raw * BigInt(recipients.length), input.decimals), totalUsdFees: sumUsd(quotes.flatMap(q => [q.fees.gasUsd, q.fees.relayerUsd, q.fees.appFeeUsd])), estimatedCompletionTimeSeconds: quotes.every(q => Number.isFinite(q.timeEstimateSeconds)) ? quotes.reduce((sum, q) => sum + q.timeEstimateSeconds, 0) : null };
}
export const checkBridgeOrderStatus = ({ requestId }, options) => fetchTransactionStatus(requestId, options);
const str = description => ({ type: 'string', description });
const chainProp = str('Supported chain slug, alias or numeric chain ID as a string (for example base, arb, solana, 8453).');
const sourceProps = { fromChain: chainProp, fromToken: str('Source token symbol such as ETH, USDC or native; amounts are denominated in this token.'), amount: str('Positive human-readable source-token amount as a decimal string; no exponent notation. Use strings to preserve precision.'), userAddress: str('Real sender address on the source chain. Omit only for a read-only preview that cannot be executed.'), recipientAddress: str('Destination wallet address, matching the destination chain VM. Verify the platform wallet before onboarding.') };
const tool = (name, title, description, properties, required, openWorldHint = true) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint } });
export const TOOLS = [
  tool('list_supported_chains_and_tokens', 'Supported chains and tokens', 'List eight supported chains, token addresses, onboarding presets and the disclosed 30 bps integrator fee.', { chain: chainProp }, [], false),
  tool('get_cross_chain_bridge_quote', 'Cross-chain bridge quote', 'Fetch a Relay quote with fee breakdown and unsigned steps. Never signs or broadcasts; missing sender creates a preview.', { ...sourceProps, toChain: chainProp, toToken: str('Destination token symbol, native, or raw contract/mint address.'), fromTokenDecimals: { type: 'integer', minimum: 0, maximum: 255, description: 'Required decimal precision for an unregistered raw source token address.' }, toTokenDecimals: { type: 'integer', minimum: 0, maximum: 255, description: 'Required decimal precision for an unregistered raw destination token address.' }, slippageBps: { type: 'integer', minimum: 0, maximum: 10000, description: 'Maximum slippage in basis points: 50 means 0.50%. Omit for Relay automatic tolerance.' } }, ['fromChain', 'toChain', 'amount']),
  tool('polymarket_one_click_onboard', 'Polymarket onboarding plan', 'Plan Polygon USDC.e plus optional POL gas. Extra gas spends additional input; this does not create a trading account.', { ...sourceProps, includeGasTopup: { type: 'boolean', default: true, description: 'Whether to quote a separate native POL top-up in addition to the full primary input.' }, gasTopupAmountUsd: { type: 'number', minimum: 0, default: 2, description: 'Approximate USD source spend for POL gas, before fees, valued from the primary quote; zero disables it.' } }, ['fromChain', 'amount']),
  tool('hyperliquid_one_click_onboard', 'Hyperliquid onboarding plan', 'Plan HyperEVM HYPE or Arbitrum USDC funding. L1 deposits remain a separate action.', { ...sourceProps, targetMode: { type: 'string', enum: ['hyperevm_hype', 'arbitrum_usdc', 'both'], default: 'hyperevm_hype', description: 'Funding destination. both quotes two routes, each spending the entire specified source amount.' } }, ['fromChain', 'amount']),
  tool('multi_wallet_gas_refuel', 'Multi-wallet gas refuel', 'Quote native gas delivery for 1–20 recipients without broadcasting, preserving recipient order.', { fromChain: chainProp, fromToken: sourceProps.fromToken, targetChain: chainProp, amountPerWallet: str('Positive decimal source-token amount spent for EACH wallet, not the amount of destination gas.'), recipients: { type: 'array', minItems: 1, maxItems: 20, items: str('Destination wallet address matching the target chain VM.'), description: 'Ordered list of 1–20 destination addresses. Duplicate addresses intentionally receive multiple allocations.' }, senderAddress: sourceProps.userAddress }, ['fromChain', 'targetChain', 'amountPerWallet', 'recipients']),
  tool('check_bridge_order_status', 'Bridge order status', 'Read Relay intent status v2 for a request ID. Does not submit or retry transactions.', { requestId: str('Relay requestId returned by the quote or executable step, at most 256 characters.') }, ['requestId'])
];
const handlers = [listSupportedRoutes, getBridgeQuote, getPolymarketOnboardPlan, getHyperliquidOnboardPlan, planMultiWalletGasRefuel, checkBridgeOrderStatus];
export async function callTool(name, args = {}, options) {
  const i = TOOLS.findIndex(t => t.name === name);
  if (i < 0) throw new Error(`Unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  const schema = TOOLS[i].inputSchema;
  for (const required of schema.required) if (args[required] === undefined) throw new Error(`Missing required argument: ${required}`);
  for (const [key, value] of Object.entries(args)) {
    const p = schema.properties[key];
    if (!p) throw new Error(`Unknown argument: ${key}`);
    if (p.type === 'array' ? !Array.isArray(value) : p.type === 'integer' ? !Number.isInteger(value) : typeof value !== p.type) throw new Error(`Invalid type for ${key}: expected ${p.type}`);
    if (p.enum && !p.enum.includes(value)) throw new Error(`Invalid ${key}`);
    if (typeof value === 'number' && (!Number.isFinite(value) || value < (p.minimum ?? -Infinity) || value > (p.maximum ?? Infinity))) throw new Error(`Out of range: ${key}`);
  }
  return handlers[i](args, options);
}
