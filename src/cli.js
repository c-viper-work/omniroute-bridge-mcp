import { listSupportedRoutes, getBridgeQuote, getPolymarketOnboardPlan, getHyperliquidOnboardPlan, planMultiWalletGasRefuel, checkBridgeOrderStatus } from './service.js';
import { startMcpServer } from './mcp-server.js';
export const HELP = `omniroute-bridge 1.0.0 — Relay cross-chain terminal

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
export async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, ...options } = {}) {
  try {
    if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { stdout.write(HELP); return 0; }
    if (argv[0] === '--version') { stdout.write('1.0.0\n'); return 0; }
    const [command, ...args] = argv;
    if (['mcp', '--mcp', '--stdio'].includes(command)) { if (args.length) throw new Error('MCP mode does not accept flags'); await startMcpServer({ ...options, output: stdout }); return 0; }
    if (!Object.hasOwn(allowed, command)) throw new Error(`Unknown command: ${command}`);
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      const flag = args[i].replace(/^--/, '');
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
    if (!flags.json) stdout.write('OmniRoute · Unsigned results · 0.30% integrator fee\n');
    stdout.write(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch (error) { stderr.write(`Error: ${error.message}\n`); return 1; }
}
