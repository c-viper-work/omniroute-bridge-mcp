import { listSupportedRoutes, getBridgeQuote, getPolymarketOnboardPlan, getHyperliquidOnboardPlan, planMultiWalletGasRefuel, checkBridgeOrderStatus } from './service.js';
import { startMcpServer } from './mcp-server.js';
import { DEFAULT_FEE_BPS, formatUnits } from './constants.js';
export const HELP = `omniroute-bridge 1.1.0 — Relay cross-chain terminal

Usage:
  omniroute-bridge mcp | --mcp | --stdio
  omniroute-bridge chains [--json]
  omniroute-bridge quote --from base --to arbitrum --token USDC --to-token ETH --amount 10 [--recipient ADDRESS] [--sender ADDRESS] [--json]
  omniroute-bridge polymarket --from base --token USDC --amount 10 [--recipient ADDRESS] [--no-gas] [--json]
  omniroute-bridge hyperliquid --from base --token USDC --amount 10 [--mode hyperevm_hype|arbitrum_usdc|both] [--json]
  omniroute-bridge refuel --from base --token USDC --to polygon --amount-per-wallet 2 --recipients ADDRESS,ADDRESS [--json]
  omniroute-bridge status --request-id ID [--json]
  omniroute-bridge --help | --version

All quote commands accept --sender ADDRESS. Omit only for previews.
No API key or subscription. 0.30% integrator + Relay/network fees apply.
CLI and MCP never sign or broadcast. Amounts are source-token units.
`;
const allowed = {
  chains: [], quote: ['from', 'to', 'token', 'to-token', 'amount', 'recipient', 'sender', 'slippage-bps'], polymarket: ['from', 'token', 'amount', 'recipient', 'sender', 'no-gas', 'gas-usd'], hyperliquid: ['from', 'token', 'amount', 'mode', 'recipient', 'sender'], refuel: ['from', 'token', 'to', 'amount-per-wallet', 'recipients', 'sender'], status: ['request-id']
};
const aliases = Object.fromEntries([
  ['from', ['from-chain', 'origin-chain', 'source-chain']],
  ['to', ['to-chain', 'dest-chain', 'destination-chain', 'target-chain']],
  ['token', ['from-token', 'origin-token', 'source-token']],
  ['to-token', ['dest-token', 'destination-token', 'target-token']],
  ['sender', ['user', 'from-address', 'sender-address']],
  ['recipient', ['to-address', 'recipient-address']],
  ['request-id', ['id']],
].flatMap(([canonical, names]) => names.map(name => [name, canonical])));
const escape = value => String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char => Array.from({ length: char.length }, (_, i) => '\\u' + char.charCodeAt(i).toString(16).padStart(4, '0')).join(''));
function routeSummary(quotes) {
  if (!quotes.length) return '';
  const line = (parts, ...values) => parts.reduce((out, part, i) => out + escape(values[i - 1]).replace(/\|/g, '\\u007c') + part);
  const available = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' ? String(value) : 'Unavailable';
  return '\n=== Route Summary ===\n' + quotes.map(q =>
    line`${q.originChain.slug} -> ${q.destinationChain.slug} | Input: ${formatUnits(q.payload.amount, q.inputToken.decimals)} ${q.inputToken.symbol} | Output: ${available(q.currencyOut.amountFormatted)} ${available(q.currencyOut.symbol)} | Min output: ${available(q.currencyOut.minimumAmountFormatted)} ${available(q.currencyOut.symbol)} | ETA: ${available(q.timeEstimateSeconds)} seconds | appFeeUsd: ${available(q.fees.appFeeUsd)} (${(Number(q.fees?.appFeeBps) / 100).toFixed(2) + '%'}) | requestId: ${available(q.requestId)}`
  ).join('\n') + '\n';
}
export async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, ...options } = {}) {
  try {
    if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { stdout.write(HELP); return 0; }
    if (argv[0] === '--version') { stdout.write('1.1.0\n'); return 0; }
    const [command, ...args] = argv;
    if (['mcp', '--mcp', '--stdio'].includes(command)) { if (args.length) throw new Error('MCP mode does not accept flags'); await startMcpServer({ ...options, output: stdout }); return 0; }
    if (!Object.hasOwn(allowed, command)) throw new Error(`Unknown command: ${command}`);
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      const name = args[i].replace(/^--/, '');
      const flag = Object.hasOwn(aliases, name) ? aliases[name] : name;
      if (!args[i].startsWith('--') || ![...allowed[command], 'json'].includes(flag)) throw new Error(`Unknown option: ${args[i]}`);
      if (Object.hasOwn(flags, flag)) throw new Error(`Duplicate option: --${flag}`);
      if (['json', 'no-gas'].includes(flag)) flags[flag] = true;
      else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for --${flag}`); flags[flag] = args[++i]; }
    }
    const common = { fromChain: flags.from, fromToken: flags.token, amount: flags.amount, recipientAddress: flags.recipient, userAddress: flags.sender };
    let result;
    switch (command) {
      case 'chains': result = listSupportedRoutes(); break;
      case 'quote': result = await getBridgeQuote({ ...common, toChain: flags.to, toToken: flags['to-token'], slippageBps: flags['slippage-bps'] }, options); break;
      case 'polymarket': result = await getPolymarketOnboardPlan({ ...common, includeGasTopup: !flags['no-gas'], gasTopupAmountUsd: flags['gas-usd'] ?? 2 }, options); break;
      case 'hyperliquid': result = await getHyperliquidOnboardPlan({ ...common, targetMode: flags.mode }, options); break;
      case 'refuel': result = await planMultiWalletGasRefuel({ ...common, targetChain: flags.to, amountPerWallet: flags['amount-per-wallet'], recipients: flags.recipients?.split(',').map(a => a.trim()), senderAddress: flags.sender }, options); break;
      case 'status': result = await checkBridgeOrderStatus({ requestId: flags['request-id'] }, options); break;
    }
    const footer = !flags.json && ['quote', 'polymarket', 'hyperliquid', 'refuel'].includes(command) ? routeSummary(command === 'quote' ? [result] : result.quotes) : '';
    const header = flags.json ? '' : `OmniRoute · Unsigned results · ${(Number(options.feeBps ?? DEFAULT_FEE_BPS) / 100).toFixed(2) + '%'} integrator fee\n`;
    const json = JSON.stringify(result, null, 2).replace(/[\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]/gu, escape);
    stdout.write(header + json + '\n' + footer);
    return 0;
  } catch (error) { stderr.write(`Error: ${escape(error?.message ?? error)}\n`); return 1; }
}
