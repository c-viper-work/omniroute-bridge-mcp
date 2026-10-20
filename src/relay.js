import { RELAY_API_BASE, DEFAULT_FEE_RECIPIENT, DEFAULT_FEE_BPS, DEFAULT_EVM_USER, DEFAULT_SOLANA_USER, resolveChain, resolveToken, isValidEvmAddress, isValidSolanaAddress, formatUnits } from './constants.js';
export function validateAddress(address, chain, label = 'Address') {
  const c = resolveChain(chain);
  if (!(c.vmType === 'evm' ? isValidEvmAddress(address) && !/^0x0{40}$/i.test(address) : isValidSolanaAddress(address) && address !== '11111111111111111111111111111111')) throw new Error(`${label} must be a valid ${c.vmType === 'evm' ? 'EVM' : 'Solana'} address for ${c.slug}`);
  return address;
}
export function basisPoints(value, label = 'Basis points') {
  if (!((typeof value === 'string') || (typeof value === 'number' && Number.isSafeInteger(value))) || !/^\d{1,5}$/.test(String(value)) || Number(value) > 10000) throw new Error(`${label} must be an integer from 0 to 10000`);
  return String(Number(value));
}
export function buildQuotePayload({ originChain, destinationChain, originToken = 'native', destinationToken = 'native', amountRaw, user, recipient, tradeType = 'EXACT_INPUT', slippageTolerance, feeRecipient = DEFAULT_FEE_RECIPIENT, feeBps = DEFAULT_FEE_BPS }) {
  const from = resolveChain(originChain), to = resolveChain(destinationChain);
  const input = resolveToken(from, originToken), output = resolveToken(to, destinationToken);
  if (!(typeof amountRaw === 'bigint' || typeof amountRaw === 'string' || (typeof amountRaw === 'number' && Number.isSafeInteger(amountRaw)))) throw new Error('amountRaw must be a bigint, digit string, or safe integer number');
  if (!/^\d+$/.test(String(amountRaw)) || String(amountRaw).length > 78 || BigInt(amountRaw) <= 0n || BigInt(amountRaw) >= 2n ** 256n) throw new Error('amountRaw must be a positive uint256 integer');
  if (!['EXACT_INPUT', 'EXACT_OUTPUT'].includes(tradeType)) throw new Error('Unsupported tradeType');
  validateAddress(feeRecipient, 'ethereum', 'Fee recipient');
  const preview = c => c.vmType === 'evm' ? DEFAULT_EVM_USER : DEFAULT_SOLANA_USER;
  const sender = user ?? preview(from);
  const receiver = recipient ?? (from.vmType === to.vmType ? sender : preview(to));
  const payload = { user: validateAddress(sender, from, 'Sender'), recipient: validateAddress(receiver, to, 'Recipient'), originChainId: from.chainId, destinationChainId: to.chainId, originCurrency: input.address, destinationCurrency: output.address, amount: BigInt(amountRaw).toString(), tradeType, appFees: [{ recipient: feeRecipient, fee: basisPoints(feeBps, 'Fee') }] };
  if (slippageTolerance !== undefined) payload.slippageTolerance = basisPoints(slippageTolerance, 'Slippage');
  return payload;
}
export class RelayError extends Error {
  constructor(message, status, details) { super(message); this.name = 'RelayError'; this.status = status; this.details = details; }
}
async function request(path, { fetchImpl = globalThis.fetch, timeoutMs = 15000, signal } = {}, body) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('Relay request timed out')), timeoutMs);
  try {
    const response = await fetchImpl(RELAY_API_BASE + path, { method: body ? 'POST' : 'GET', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, redirect: 'error' });
    let data;
    try { data = await response.json(); } catch { throw new RelayError(`Relay returned invalid JSON (HTTP ${response.status})`, response.status); }
    if (!response.ok) {
      const errText = typeof data?.message === 'string' && data.message ? data.message : typeof data?.error === 'string' && data.error ? data.error : 'Request failed';
      throw new RelayError(`Relay HTTP ${response.status}: ${errText}`, response.status, data);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RelayError('Relay returned an invalid response', response.status);
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new RelayError(signal?.aborted ? 'Relay request cancelled' : 'Relay request timed out');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function currency(value = {}) {
  const c = value.currency ?? {};
  const safeFormat = amount => {
    try { return amount !== undefined && Number.isInteger(c.decimals) ? formatUnits(amount, c.decimals) : null; }
    catch { return null; }
  };
  return { symbol: c.symbol ?? null, amount: value.amount ?? null, amountFormatted: value.amountFormatted ?? safeFormat(value.amount), minimumAmountFormatted: safeFormat(value.minimumAmount), amountUsd: value.amountUsd ?? null };
}
export async function fetchRelayQuote(payload, options = {}) {
  // Rebuild at the HTTP boundary: callers cannot bypass the integrator fee with a hand-written payload.
  const from = resolveChain(payload.originChainId), to = resolveChain(payload.destinationChainId);
  const wire = buildQuotePayload({ originChain: from, destinationChain: to, originToken: { address: payload.originCurrency, decimals: 18 }, destinationToken: { address: payload.destinationCurrency, decimals: 18 }, amountRaw: payload.amount, user: payload.user, recipient: payload.recipient, tradeType: payload.tradeType, slippageTolerance: payload.slippageTolerance, feeRecipient: options.feeRecipient ?? DEFAULT_FEE_RECIPIENT, feeBps: options.feeBps ?? DEFAULT_FEE_BPS });
  const data = await request('/quote', options, wire);
  if (!data.details?.currencyIn || !data.details?.currencyOut || !Array.isArray(data.steps)) throw new RelayError('Relay quote is missing currency details or steps');
  const d = data.details, f = data.fees ?? {};
  const steps = data.steps.map(step => ({ id: step.id, action: step.action, description: step.description, kind: step.kind, requestId: step.requestId, items: (step.items ?? []).map(item => ({ ...item, to: item.data?.to, from: item.data?.from, value: item.data?.value, chainId: item.data?.chainId, checkEndpoint: item.check?.endpoint })) }));
  return { requestId: data.requestId ?? steps.find(s => s.requestId)?.requestId ?? null, originChain: from, destinationChain: to, currencyIn: currency(d.currencyIn), currencyOut: currency(d.currencyOut), rate: d.rate ?? null, totalImpactPercent: d.totalImpact?.percent ?? null, timeEstimateSeconds: d.timeEstimate ?? null, fees: { gasUsd: f.gas?.amountUsd ?? null, relayerUsd: f.relayer?.amountUsd ?? null, appFeeUsd: f.app?.amountUsd ?? null, appFeeRecipient: wire.appFees[0].recipient, appFeeBps: wire.appFees[0].fee }, steps, payload: wire, quotedAt: new Date().toISOString() };
}
export function fetchTransactionStatus(requestId, options) {
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 256) throw new Error('requestId must be a non-empty string of at most 256 characters');
  return request('/intents/status/v2?requestId=' + encodeURIComponent(requestId), options);
}
export function fetchAppFeeBalances(walletAddress = DEFAULT_FEE_RECIPIENT, options) {
  validateAddress(walletAddress, 'ethereum', 'Fee wallet');
  return request('/app-fees/' + walletAddress + '/balances', options);
}
