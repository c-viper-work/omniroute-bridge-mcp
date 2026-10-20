import { isValidEvmAddress, resolveChain } from './constants.js';
export const MAX_AGE_MS = 60000;
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function cliCommand(mode, args) {
  const flags = { fromChain: 'from', fromToken: 'token', toChain: 'to', toToken: 'to-token', amount: 'amount', userAddress: 'sender', senderAddress: 'sender', recipientAddress: 'recipient', targetMode: 'mode', gasTopupAmountUsd: 'gas-usd', targetChain: 'to', amountPerWallet: 'amount-per-wallet', recipients: 'recipients' };
  const parts = ['omniroute-bridge', mode];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === '') continue;
    if (key === 'includeGasTopup') { if (!value) parts.push('--no-gas'); continue; }
    if (flags[key]) parts.push('--' + flags[key], shellQuote(Array.isArray(value) ? value.join(',') : value));
  }
  return parts.join(' ') + ' --json';
}
function quantity(value) {
  if (!(typeof value === 'string' && /^(0x[0-9a-f]+|[0-9]+)$/i.test(value)) && !(Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid transaction quantity');
  const n = BigInt(value); if (n < 0n || n >= 2n ** 256n) throw new Error('Transaction quantity out of range');
  return '0x' + n.toString(16);
}
export function preflight(plan, account, now = Date.now()) {
  if (!isValidEvmAddress(account) || plan.previewOnly) throw new Error('Connect your EVM wallet and request a new non-preview quote.');
  const txs = [];
  for (const [quoteIndex, q] of plan.quotes.entries()) {
    const age = now - Date.parse(q.quotedAt);
    if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) throw new Error('Quote expired. Request and review a fresh quote.');
    if (q.previewOnly || q.originChain.vmType !== 'evm' || q.payload.user.toLowerCase() !== account.toLowerCase()) throw new Error('Sender mismatch or Solana source: use unsigned export.');
    let nativeValueSum = 0n, tokenSpendSum = 0n;
    const tokenAddress = (q.inputToken?.address ?? q.payload?.originCurrency ?? '').toLowerCase();
    if (!isValidEvmAddress(tokenAddress) || (q.inputToken?.address && q.payload?.originCurrency && q.inputToken.address.toLowerCase() !== q.payload.originCurrency.toLowerCase())) throw new Error('Invalid transaction calldata or sender');
    const isNativeInput = /^0x0{40}$/.test(tokenAddress);
    for (const step of q.steps) {
      if (step.kind !== 'transaction') throw new Error('Signature or unsupported steps: use unsigned export.');
      if (!Array.isArray(step.items) || !step.items.length) throw new Error('Empty transaction step');
      for (const item of step.items) {
        if (item.status === 'complete') continue;
        const d = item.data;
        if (!d || !isValidEvmAddress(d.to) || /^0x0{40}$/i.test(d.to) || !/^0x(?:[0-9a-f]{2})*$/i.test(d.data ?? '') || !isValidEvmAddress(d.from) || d.from.toLowerCase() !== account.toLowerCase()) throw new Error('Invalid transaction calldata or sender');
        const chain = resolveChain(d.chainId);
        if (chain.vmType !== 'evm' || chain.chainId !== q.originChain.chainId) throw new Error('Unexpected execution chain');
        const tx = { chainId: quantity(chain.chainId), from: account, to: d.to, data: d.data, value: quantity(d.value ?? '0') };
        const val = BigInt(tx.value);
        const selector = d.data.slice(0, 10).toLowerCase();
        const targetsInputToken = !isNativeInput && d.to.toLowerCase() === tokenAddress;
        if (targetsInputToken || ['0x095ea7b3', '0x39509351', '0xd73dd623', '0x87517c45', '0xa22cb465', '0xd505accf'].includes(selector)) {
          if (isNativeInput || !targetsInputToken || val !== 0n) throw new Error('Invalid transaction calldata or sender');
          if (!['0x095ea7b3', '0xa9059cbb'].includes(selector) || d.data.length !== 138 || !/^0{24}[0-9a-f]{40}$/i.test(d.data.slice(10, 74)) || /^0{64}$/i.test(d.data.slice(10, 74))) throw new Error('Invalid transaction calldata or sender');
          tokenSpendSum += BigInt('0x' + d.data.slice(74, 138));
          if (tokenSpendSum > BigInt(q.payload.amount)) throw new Error('Invalid transaction calldata or sender');
        } else {
          if (!isNativeInput && val !== 0n) throw new Error('Invalid transaction calldata or sender');
          nativeValueSum += val;
          if (isNativeInput && nativeValueSum > BigInt(q.payload.amount)) throw new Error('Invalid transaction calldata or sender');
        }
        for (const key of ['gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'nonce']) if (d[key] !== undefined) tx[key] = quantity(d[key]);
        if (tx.gasPrice && (tx.maxFeePerGas || tx.maxPriorityFeePerGas)) throw new Error('Conflicting gas fields');
        txs.push({ tx, chainId: quantity(chain.chainId), quoteIndex });
      }
    }
  }
  if (!txs.length) throw new Error('No executable transactions');
  return txs;
}
export class WalletExecutor {
  constructor(provider, { now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), receiptTimeout = 120000 } = {}) { Object.assign(this, { provider, now, sleep, receiptTimeout }); this.busy = false; this.attempted = new WeakSet(); }
  async execute(plan, account, { valid = () => true, progress = () => {} } = {}) {
    if (this.busy || this.attempted.has(plan)) throw new Error('Execution already started; never resubmit this plan.');
    this.busy = true;
    try {
      const txs = preflight(plan, account, this.now());
      let firstSentAt;
      const checkFreshness = () => {
        preflight(plan, account, firstSentAt ?? this.now());
        if (firstSentAt !== undefined && this.now() - firstSentAt > txs.length * this.receiptTimeout) throw new Error('Quote expired. Request and review a fresh quote.');
      };
      for (const { tx, chainId, quoteIndex } of txs) {
        if (!valid()) throw new Error('Quote invalidated; stop and review wallet history.');
        if (BigInt(await this.provider.request({ method: 'eth_chainId' })) !== BigInt(chainId)) {
          await this.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
          throw new Error('Chain switched. Request and review a fresh quote before execution.');
        }
        checkFreshness();
        const accounts = await this.provider.request({ method: 'eth_accounts' });
        const currentChain = await this.provider.request({ method: 'eth_chainId' });
        if (!valid() || accounts[0]?.toLowerCase() !== account.toLowerCase() || BigInt(currentChain) !== BigInt(chainId)) throw new Error('Wallet account or chain changed. Request a new quote.');
        checkFreshness();
        let hash;
        firstSentAt ??= this.now();
        this.attempted.add(plan);
        try { hash = await this.provider.request({ method: 'eth_sendTransaction', params: [tx] }); }
        catch (e) { throw new Error(`Submission stopped (${e.message}). Check wallet history; status may be unknown. Do not automatically resend.`); }
        progress({ quoteIndex, hash, status: 'Submitted; bridge completion not confirmed' });
        if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Unknown submission status. Check wallet history.');
        const deadline = this.now() + this.receiptTimeout;
        let receipt;
        while (this.now() < deadline) {
          if (!valid() || BigInt(await this.provider.request({ method: 'eth_chainId' })) !== BigInt(chainId)) throw new Error('Wallet changed after submission. Check recorded hash.');
          receipt = await this.provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
          if (receipt) break;
          await this.sleep(1500);
        }
        if (!receipt) throw new Error('Receipt timeout. Check recorded hash; do not resend.');
        if (!['0x1', '0x01'].includes(receipt.status)) throw new Error('Transaction failed. Remaining steps stopped.');
        progress({ quoteIndex, hash, status: 'Source transaction confirmed; check Relay delivery status' });
      }
    } finally { this.busy = false; }
  }
}
