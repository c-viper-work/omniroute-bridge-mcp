export const RELAY_API_BASE = 'https://api.relay.link';
export const DEFAULT_FEE_RECIPIENT = '0x8c2279495094C284e1293cdE9DBC52cc4f55C6bd';
export const DEFAULT_SOLANA_FEE_RECIPIENT = 'FJCcoqJHmoJyuthUY773gnxBsAY8yQuAgfYwL3zETVVW';
export const DEFAULT_FEE_BPS = '30';
export const DEFAULT_EVM_USER = '0x000000000000000000000000000000000000dEaD';
export const DEFAULT_SOLANA_USER = '11111111111111111111111111111112';
const ZERO = '0x0000000000000000000000000000000000000000';
const token = (address, decimals, symbol) => ({ address, decimals, symbol });
const native = symbol => token(ZERO, 18, symbol);
const chain = (slug, chainId, aliases, nativeSymbol, explorerUrl, tokens, vmType = 'evm') => ({ slug, chainId, aliases, vmType, nativeSymbol, nativeDecimals: vmType === 'svm' ? 9 : 18, explorerUrl, tokens });
export const CHAINS = {
  ethereum: chain('ethereum', 1, ['eth', 'mainnet', '1'], 'ETH', 'https://etherscan.io', { ETH: native('ETH'), USDC: token('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 'USDC'), USDT: token('0xdAC17F958D2ee523a2206206994597C13D831ec7', 6, 'USDT') }),
  base: chain('base', 8453, ['base', '8453'], 'ETH', 'https://basescan.org', { ETH: native('ETH'), USDC: token('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6, 'USDC') }),
  arbitrum: chain('arbitrum', 42161, ['arb', 'arbitrum', '42161'], 'ETH', 'https://arbiscan.io', { ETH: native('ETH'), USDC: token('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, 'USDC'), USDT: token('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6, 'USDT') }),
  optimism: chain('optimism', 10, ['op', 'optimism', '10'], 'ETH', 'https://optimistic.etherscan.io', { ETH: native('ETH'), USDC: token('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6, 'USDC') }),
  polygon: chain('polygon', 137, ['pol', 'polygon', 'matic', '137'], 'POL', 'https://polygonscan.com', { POL: native('POL'), MATIC: native('POL'), 'USDC.E': token('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6, 'USDC.e'), USDC: token('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6, 'USDC'), USDT: token('0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6, 'USDT') }),
  bsc: chain('bsc', 56, ['bnb', 'bsc', '56'], 'BNB', 'https://bscscan.com', { BNB: native('BNB'), USDC: token('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18, 'USDC'), USDT: token('0x55d398326f99059fF775485246999027B3197955', 18, 'USDT') }),
  hyperevm: chain('hyperevm', 999, ['hyperliquid', 'hyperevm', 'hype', '999'], 'HYPE', 'https://hyperevmscan.io', { HYPE: native('HYPE') }),
  solana: chain('solana', 792703809, ['sol', 'solana', '792703809'], 'SOL', 'https://solscan.io', { SOL: token('11111111111111111111111111111111', 9, 'SOL'), USDC: token('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, 'USDC'), USDT: token('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6, 'USDT') }, 'svm')
};
function freeze(value) { Object.values(value).forEach(v => { if (v && typeof v === 'object') freeze(v); }); return Object.freeze(value); }
freeze(CHAINS);
export function resolveChain(input) {
  const key = String(input?.chainId ?? input).toLowerCase();
  const found = Object.values(CHAINS).find(c => c.slug === key || String(c.chainId) === key || c.aliases.includes(key));
  if (!found) throw new Error(`Unknown chain: ${key}. Supported: ${Object.keys(CHAINS).join(', ')}`);
  return found;
}
export const isValidEvmAddress = addr => typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr);
export function isValidSolanaAddress(addr) {
  if (typeof addr !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of addr) n = n * 58n + BigInt(alphabet.indexOf(ch));
  const bytes = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2);
  return bytes + (addr.match(/^1*/)[0].length) === 32;
}
function validDecimals(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('Decimals must be an integer from 0 to 255');
}
export function resolveToken(chainInput, tokenInput = 'native', customDecimals) {
  const c = resolveChain(chainInput);
  const input = typeof tokenInput === 'object' && tokenInput ? tokenInput.address : tokenInput;
  const key = String(input).toUpperCase();
  const known = c.tokens[key === 'NATIVE' ? c.nativeSymbol : key] ?? Object.values(c.tokens).find(t => c.vmType === 'evm' ? t.address.toLowerCase() === String(input).toLowerCase() : t.address === input);
  if (known) return { ...known };
  if (!(c.vmType === 'evm' ? isValidEvmAddress(input) : isValidSolanaAddress(input))) throw new Error(`Unknown token or invalid address on ${c.slug}: ${input}`);
  const decimals = customDecimals ?? tokenInput?.decimals;
  validDecimals(decimals);
  return { address: input, decimals, symbol: tokenInput?.symbol ?? 'CUSTOM' };
}
export function parseUnits(amount, decimals) {
  validDecimals(decimals);
  if (typeof amount !== 'string' && typeof amount !== 'number') throw new Error('Amount must be a decimal string or number');
  if (typeof amount === 'number' && (!Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe numeric amount; use a decimal string');
  const str = String(amount);
  if (!/^\d+(\.\d+)?$/.test(str) || str.length > 512) throw new Error('Amount must be a positive plain decimal, without exponent notation');
  const [whole, fraction = ''] = str.split('.');
  if (fraction.length > decimals) throw new Error(`Amount has excess decimal digits; maximum is ${decimals}`);
  const raw = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (raw <= 0n) throw new Error('Amount must be greater than zero');
  if (raw >= 2n ** 256n) throw new Error('Amount overflows uint256');
  return raw;
}
export function formatUnits(raw, decimals) {
  validDecimals(decimals);
  if (typeof raw !== 'string' && typeof raw !== 'bigint') throw new Error('Raw amount must be an integer string or BigInt');
  if (!/^-?\d+$/.test(String(raw))) throw new Error('Raw amount must be an integer string or BigInt');
  const n = BigInt(raw), sign = n < 0n ? '-' : '', s = (n < 0n ? -n : n).toString().padStart(decimals + 1, '0');
  if (!decimals) return sign + s;
  const fraction = s.slice(-decimals).replace(/0+$/, '');
  return sign + s.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
