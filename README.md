# OmniRoute Bridge MCP

[![MIT](https://img.shields.io/badge/license-MIT-a3e635)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/npm_dependencies-0-22d3ee)](package.json)
[![MCP](https://img.shields.io/badge/MCP-6_tools-8b5cf6)](src/service.js)

**One terminal for cross-chain funding, platform onboarding, and multi-wallet gas.**

[Web App](https://c-viper-work.github.io/omniroute-bridge-mcp/) · [Source](https://github.com/c-viper-work/omniroute-bridge-mcp) · [Relay](https://relay.link)

Zero API keys. Zero npm runtime dependencies. MIT-licensed Node.js SDK, CLI, and MCP server. Supports Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Smart Chain, HyperEVM, and Solana.

Free to install and use: **no subscription or API-key purchase**. Every Relay quote includes a **30 bps (0.30%) integrator fee**, plus applicable Relay and network fees. It is not fee-free bridging. Fast routes may settle in roughly 2 seconds, but sub-3-second execution is not guaranteed; quote latency, approvals, network confirmation and final settlement vary. Always use the live quote estimate.

## Quick start

From this source checkout (no installation required):

```sh
node bin/omniroute.js chains --json
node bin/omniroute.js quote --from base --to arbitrum --token USDC --to-token ETH --amount 10 --json
npm test
npm start
```

After the maintainer publishes version 1.0.0 to npm, the equivalent commands are:

```sh
npx -y --package omniroute-bridge-mcp omniroute-bridge chains
npx -y --package omniroute-bridge-mcp omniroute-bridge-mcp mcp
```

Publication and GitHub Pages deployment are separate maintainer actions; this repository does not automatically publish itself.

### Claude Desktop, Cursor and Windsurf

Use the following `mcpServers` entry in Claude Desktop's MCP configuration, Cursor's MCP settings, or Windsurf's MCP configuration. Replace the project path with your checkout location. No secret or environment variable is needed.

```json
{
  "mcpServers": {
    "omniroute": {
      "command": "node",
      "args": ["/absolute/path/to/omniroute-bridge-mcp/bin/omniroute.js", "mcp"]
    }
  }
}
```

After npm publication, use `"command": "npx"` and `"args": ["-y", "--package", "omniroute-bridge-mcp", "omniroute-bridge-mcp", "mcp"]` instead.

Try asking: “Quote 10 USDC from Base to native POL on Polygon,” or “Plan gas funding for these three wallets.” All six tools are read-only: they return unsigned plans and never hold keys, sign, broadcast, or trade.

## CLI

```sh
# List supported chains and tokens
node bin/omniroute.js chains --json

# Read-only bridge preview
node bin/omniroute.js quote --from solana --to base --token USDC --to-token ETH --amount 10 --json

# Include real source and destination wallet addresses for executable quote data
node bin/omniroute.js quote --from base --to arbitrum --token USDC --to-token ETH --amount 10 --sender YOUR_EVM_ADDRESS --recipient YOUR_EVM_ADDRESS --json

# Polymarket: Polygon USDC.e plus an additional approximately $2 source spend for POL
node bin/omniroute.js polymarket --from base --token USDC --amount 50 --recipient YOUR_POLYGON_ADDRESS --json
# Skip the extra gas route
node bin/omniroute.js polymarket --from base --token USDC --amount 50 --no-gas --json

# HyperEVM native HYPE
node bin/omniroute.js hyperliquid --from arbitrum --token USDC --amount 25 --mode hyperevm_hype --json
# Prepare Arbitrum USDC for the official Hyperliquid deposit flow
node bin/omniroute.js hyperliquid --from base --token USDC --amount 25 --mode arbitrum_usdc --json

# Spend 2 source USDC per destination wallet to buy Polygon POL
node bin/omniroute.js refuel --from base --token USDC --to polygon --amount-per-wallet 2 --recipients ADDRESS_1,ADDRESS_2 --sender YOUR_SOURCE_ADDRESS --json

node bin/omniroute.js status --request-id RELAY_REQUEST_ID --json
node bin/omniroute.js --help
```

`--sender` is supported by all quote-producing commands. Without it, returned data is marked `previewOnly`; do not sign preview calldata. For cross-VM routes, also specify the real destination recipient. `--slippage-bps 50` means 0.50% on the `quote` command. `--gas-usd` changes the additional Polymarket gas budget. `--mode both` quotes two full-size Hyperliquid funding routes and doubles the source input budget.

### Onboarding boundaries

- **Polymarket:** the preset targets Polygon bridged USDC.e (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`), distinct from native USDC. Optional gas is a separate POL route. Use the intended platform wallet; a transfer to an arbitrary EOA does not create or fund every kind of Polymarket account automatically. Account setup, approvals and current platform deposit requirements still apply.
- **HyperEVM:** native HYPE on chain 999 funds EVM gas. This is not Hyperliquid L1 perpetuals collateral.
- **Arbitrum USDC:** prepares funds for the official Hyperliquid deposit flow; it does not call Bridge2. Keep Arbitrum ETH for the separate deposit transaction and check the platform's current minimums.
- **Gas refuel:** `amountPerWallet` is input in the source token. Output native gas is quoted after fees. Up to 20 recipients, four concurrent quote requests, ordered unsigned steps. Duplicate recipients mean repeated allocations. Execution is not atomic; track each submitted transaction separately.
- **USD gas budget:** estimated using the primary quote's source USD valuation. The gas route is additional spend, not deducted from the primary amount. It is not a guarantee of that many dollars of POL after fees; missing USD pricing causes an explicit error.

See [Polymarket's official bridge guide](https://github.com/Polymarket/agent-skills/blob/main/bridge.md) and [Hyperliquid onboarding](https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/how-to-start-trading) for the destination platform flows.

## Node.js SDK

```js
import {
  getBridgeQuote,
  getPolymarketOnboardPlan,
  getHyperliquidOnboardPlan,
  planMultiWalletGasRefuel,
  checkBridgeOrderStatus,
  fetchAppFeeBalances
} from 'omniroute-bridge-mcp';

const quote = await getBridgeQuote({
  fromChain: 'base', toChain: 'arbitrum',
  fromToken: 'USDC', toToken: 'ETH', amount: '10',
  userAddress: 'YOUR_SOURCE_ADDRESS',
  recipientAddress: 'YOUR_DESTINATION_ADDRESS',
  slippageBps: 50
});
console.log(quote.currencyOut, quote.fees, quote.steps);
// No signing occurs. Review and execute with your own wallet integration.
```

In a source checkout, import from `./src/index.js`. The illustrative address placeholders must be replaced with valid addresses. To preview instead, omit the address fields.

All network methods accept a final `options` object: `{ fetchImpl, timeoutMs, signal, feeRecipient, feeBps }`. Default timeout is 15 seconds. Injectable fetch supports deterministic offline tests. Fee overrides are explicit testing/configuration options; CLI and MCP expose no fee override. There is no automatic retry of quotes or transactions.

`resolveToken(chain, rawAddress, customDecimals)` supports custom tokens with explicit decimals. `getBridgeQuote` accepts `fromTokenDecimals` / `toTokenDecimals` for raw addresses. Registered tokens use the audited registry decimals; arbitrary mint/contract metadata is not fetched. Address validation checks syntax and Solana decoded length, not ownership or token safety.

Use **decimal strings** for exact amounts. `parseUnits` returns BigInt, rejects zero, negatives, scientific notation, excess decimals and uint256 overflow. JavaScript numbers cannot recover precision already lost before the call. `formatUnits` returns an exact decimal string, with support for zero and negative values for display.

### Quote result

Results include `requestId`, chain metadata, input/output amounts and USD values, minimum output, rate, impact, estimated seconds, gas/relayer/app fees, `payload`, `quotedAt`, `previewOnly` and ordered `steps`. Missing upstream estimates are `null`, never invented. Relay step data and check endpoints are preserved, including non-EVM data. A signature or Solana transaction cannot be passed to EVM `eth_sendTransaction`.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `list_supported_chains_and_tokens` | Registry, presets and fee disclosure |
| `get_cross_chain_bridge_quote` | Cross-chain unsigned quote |
| `polymarket_one_click_onboard` | Polygon USDC.e and optional POL |
| `hyperliquid_one_click_onboard` | HyperEVM HYPE / Arbitrum USDC |
| `multi_wallet_gas_refuel` | Up to 20 native gas allocations |
| `check_bridge_order_status` | Relay intent status v2 |

Each tool has a title, read-only/non-destructive/idempotent annotations and descriptions on every parameter. `openWorldHint` is false only for the local registry tool. The idempotent annotation describes absence of transaction side effects; live quotes and request IDs can change. Metadata coverage is locally tested; no external Glama grade is claimed.

The stdio server accepts modern newline-delimited JSON and legacy Content-Length framing (UTF-8 byte counts), fragmented frames, notifications, and `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `prompts/list`. Responses use each request's framing. Stdout contains only protocol responses in MCP mode. Messages are limited to 1 MiB.

## Fees and Relay integration

Every HTTP quote request includes:

```json
{
  "appFees": [{
    "recipient": "0x8c2279495094C284e1293cdE9DBC52cc4f55C6bd",
    "fee": "30"
  }]
}
```

The dedicated project wallets are EVM `0x8c2279495094C284e1293cdE9DBC52cc4f55C6bd` and Solana `FJCcoqJHmoJyuthUY773gnxBsAY8yQuAgfYwL3zETVVW`; both are disclosed by `listSupportedRoutes().integratorFee`.

The Relay app fee recipient is always an **EVM address, including Solana routes**. The default is centralized and the HTTP boundary reconstructs the fee field even when a low-level caller omits it. Default balances can be queried with `fetchAppFeeBalances()`; there is no automatic fee withdrawal.

Endpoints: `POST https://api.relay.link/quote`, `GET /intents/status/v2?requestId=...`, `GET /app-fees/{wallet}/balances`. This project intentionally uses the requested `/quote` endpoint. [Relay currently documents it as deprecated](https://docs.relay.link/references/api/get-quote); compatibility and public rate limits are upstream concerns. The project does not promise unlimited API access or perpetual upstream availability. HTTP, JSON, timeout and cancellation errors propagate clearly; no private key or API key is required.

## Architecture

```text
CLI / MCP client / Node.js application
                 |
             service.js      presets, validation, batch aggregation, tool schemas
                 |
              relay.js       HTTP boundary, fees, timeout, normalization
                 |
          api.relay.link      unsigned quote / status

constants.js                 chain registry and exact amount arithmetic
```

`src/index.js` exports the public SDK. `src/mcp-server.js` provides stdio transport. `src/cli.js` handles CLI arguments; `bin/omniroute.js` is the executable entry. No signing keys, telemetry, database, server account or hosted backend are needed.

## Development and release

```sh
npm test
node --check src/service.js
npm pack --dry-run
# Optional, with Docker installed:
docker build -t omniroute-bridge-mcp .
docker run --rm -i omniroute-bridge-mcp
```

Tests use native `node:test`, `node:assert`, deterministic Relay fixtures, stream fragmentation and CLI subprocesses. They never spend funds. They cover fee injection, EVM/Solana directions, input precision and validation, all service/tool/CLI entry points and protocol framing. Mock tests do not establish live liquidity, settlement performance, browser wallet compatibility or platform crediting.

Before a public release, independently verify supported live routes and browser-wallet behavior, review executable transactions, publish the npm package, and enable GitHub Pages from `docs/`. Do not execute stale quotes or resend a transaction whose submission status is unknown. Nothing in the SDK automatically broadcasts a transaction.

## License

[MIT](LICENSE) · maintained by [c-viper-work](https://github.com/c-viper-work).

### Static web app

Serve `docs/` over HTTPS (GitHub Pages) or a local HTTP server, for example
`python3 -m http.server 8080 --directory docs`. Open `http://localhost:8080`.
The app calls Relay directly, with no keys or third-party JavaScript. Wallet
execution requires an injected EIP-1193 provider; CLI/JSON export also works
without a wallet. CLI commands request fresh unsigned plans, never broadcast.
Quotes expire after 60 seconds. Chain/account changes require a new quote.
Transaction hashes remain visible after failures; never automatically retry a
submitted plan. Source confirmation and Relay destination delivery are separate.

After changing shared quote modules, synchronize the deployed browser copies:

```sh
cp src/constants.js src/relay.js src/service.js docs/lib/
npm test
```

Tests enforce byte equality for these modules. No build step is required.
