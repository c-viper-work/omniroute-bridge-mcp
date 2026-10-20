import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { startMcpServer, handleRpc, TOOLS } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { USER, mockRelay } from './helpers.js';
async function cli(argv, relay = mockRelay()) {
  let out = '', err = '';
  const code = await runCli(argv, { ...relay, stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } } });
  return { code, out, err };
}
test('every CLI alias resolves before validation and canonical duplicate detection', async () => {
  const base = ['quote', '--from', 'base', '--to', 'arbitrum', '--token', 'USDC', '--to-token', 'ETH', '--sender', USER, '--recipient', USER, '--amount', '10', '--json'];
  for (const [canonical, names] of Object.entries({ from: ['from-chain', 'origin-chain', 'source-chain'], to: ['to-chain', 'dest-chain', 'destination-chain', 'target-chain'], token: ['from-token', 'origin-token', 'source-token'], 'to-token': ['dest-token', 'destination-token', 'target-token'], sender: ['user', 'from-address', 'sender-address'], recipient: ['to-address', 'recipient-address'], 'request-id': ['id'] })) {
    const argv = canonical === 'request-id' ? ['status', '--request-id', 'test', '--json'] : base;
    const expectedRelay = mockRelay(); await cli(argv, expectedRelay);
    for (const alias of names) {
      const aliased = argv.map(v => v === '--' + canonical ? '--' + alias : v);
      const relay = mockRelay(), result = await cli(aliased, relay);
      assert.equal(result.code, 0, result.err); assert.ok(JSON.parse(result.out));
      assert.deepEqual(relay.calls, expectedRelay.calls);
      for (const first of [canonical, alias]) {
        const duplicate = await cli([argv[0], '--' + first, 'base', '--' + alias, 'arbitrum']);
        assert.equal(duplicate.code, 1); assert.equal(duplicate.err, `Error: Duplicate option: --${canonical}\n`);
      }
    }
  }
  assert.match((await cli(['chains', '--from-chain', 'base'])).err, /Unknown option/);
});
test('CLI mode aliases work while MCP schema remains canonical', async () => {
  for (const [mode, destination] of [['hyperevm-hype', 'hyperevm'], ['arbitrum-usdc', 'arbitrum']]) {
    const result = await cli(['hyperliquid', '--from', 'base', '--token', 'USDC', '--amount', '10', '--mode', mode, '--json']);
    assert.equal(result.code, 0, result.err);
    assert.equal(JSON.parse(result.out).quotes[0].destinationChain.slug, destination);
  }
  assert.deepEqual(TOOLS.find(t => t.name === 'hyperliquid_one_click_onboard').inputSchema.properties.targetMode.enum, ['hyperevm_hype', 'arbitrum_usdc', 'both']);
});
test('human CLI footer is last, includes every route, and is absent in JSON mode', async () => {
  for (const argv of [
    ['quote', '--from', 'base', '--to', 'arbitrum', '--token', 'USDC', '--amount', '10'],
    ['hyperliquid', '--from', 'base', '--token', 'USDC', '--amount', '10', '--mode', 'both'],
  ]) {
    const result = await cli(argv); assert.equal(result.code, 0, result.err);
    const [body, footer] = result.out.split('\n=== Route Summary ===\n');
    const payload = JSON.parse(body.slice(body.indexOf('{'))), quotes = payload.quotes ?? [payload];
    assert.deepEqual(footer.trimEnd().split('\n'), quotes.map(q => `base -> ${q.destinationChain.slug} | Input: 10 USDC | Output: 9.9 OUT | Min output: 9.8 OUT | ETA: 2 seconds | appFeeUsd: 0.03 (0.30%) | requestId: ${q.requestId}`));
    const json = await cli([...argv, '--json']); assert.equal(json.code, 0); assert.ok(JSON.parse(json.out)); assert.doesNotMatch(json.out, /Route Summary|Unsigned results/);
  }
  for (const argv of [['chains'], ['status', '--id', 'test']]) assert.doesNotMatch((await cli(argv)).out, /Route Summary/);
});
test('CLI route summary escapes field delimiters in upstream values', async () => {
  const relay = mockRelay();
  const requestId = 'legitimate-id | Min output: 100000 USDC | appFeeUsd: 0 (0.00%)';
  const result = await cli(['quote', '--from', 'base', '--to', 'arbitrum', '--token', 'USDC', '--amount', '10'], {
    fetchImpl: async (...args) => {
      const data = await (await relay.fetchImpl(...args)).json();
      data.requestId = requestId;
      return new Response(JSON.stringify(data));
    },
  });
  assert.equal(result.code, 0, result.err);
  const [body, footer] = result.out.split('\n=== Route Summary ===\n');
  assert.equal(JSON.parse(body.slice(body.indexOf('{'))).requestId, requestId);
  const lines = footer.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('requestId: legitimate-id \\u007c Min output: 100000 USDC \\u007c appFeeUsd: 0 (0.00%)'));
  assert.equal(lines[0].split(' | ').length - 1, 6);
});
test('CLI status ignores route-like payload fields in human and JSON modes', async () => {
  const payload = { status: 'success', originChain: 8453, quotes: [{}] };
  for (const flags of [[], ['--json']]) {
    const result = await cli(['status', '--id', 'test', ...flags], {
      fetchImpl: async () => new Response(JSON.stringify(payload)),
    });
    assert.equal(result.code, 0, result.err);
    assert.equal(result.err, '');
    assert.doesNotMatch(result.out, /Route Summary/);
    assert.deepEqual(JSON.parse(result.out.slice(result.out.indexOf('{'))), payload);
  }
});
test('CLI header and route summary reflect custom fee basis points', async () => {
  const result = await cli(['quote', '--from', 'base', '--to', 'arbitrum', '--token', 'USDC', '--amount', '10'], { ...mockRelay(), feeBps: 100 });
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /^OmniRoute · Unsigned results · 1\.00% integrator fee\n/);
  const footer = result.out.split('\n=== Route Summary ===\n')[1];
  assert.match(footer, /appFeeUsd: 0\.03 \(1\.00%\)/);
  assert.doesNotMatch(result.out, /0\.30%/);
});
test('human CLI renders object symbols as Unavailable in a single stdout write', async () => {
  const relay = mockRelay(), writes = [];
  let err = '';
  const code = await runCli(['quote', '--from', 'base', '--to', 'arbitrum', '--token', 'USDC', '--amount', '10'], {
    fetchImpl: async (...args) => {
      const data = await (await relay.fetchImpl(...args)).json();
      data.details.currencyOut.currency.symbol = { toString: 'OUT' };
      return new Response(JSON.stringify(data));
    },
    stdout: { write: s => writes.push(s) },
    stderr: { write: s => { err += s; } },
  });
  assert.equal(code, 0, err);
  assert.equal(err, '');
  assert.equal(writes.length, 1);
  const footer = writes[0].split('\n=== Route Summary ===\n')[1];
  assert.match(footer, /Output: 9\.9 Unavailable \| Min output: 9\.8 Unavailable/);
});
for (const flags of [[], ['--json']]) test(`CLI output escapes terminal controls (${flags.length ? 'JSON' : 'human'})`, async () => {
  const relay = mockRelay();
  const malicious = '\x1b[2J\x1b[HFORGED\nLINE' + Array.from({ length: 160 }, (_, i) => String.fromCharCode(i)).filter(c => /[\x00-\x1f\x7f-\x9f]/.test(c)).join('') + '\u2028\u2029\u202e' + String.fromCodePoint(0x1BCA0, 0xE0001);
  const result = await cli(['quote', '--from', 'base', '--to', 'arbitrum', '--token', 'USDC', '--amount', '10', ...flags], {
    fetchImpl: async (...args) => {
      const data = await (await relay.fetchImpl(...args)).json();
      data.details.currencyOut.currency.symbol = malicious;
      data.requestId = malicious;
      return new Response(JSON.stringify(data));
    },
  });
  assert.equal(result.code, 0, result.err);
  assert.equal(Buffer.from(result.out).includes(0x1b), false);
  assert.doesNotMatch(result.out.replace(/\n/g, ''), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  const body = result.out.split('\n=== Route Summary ===\n')[0];
  assert.equal(JSON.parse(body.slice(body.indexOf('{'))).requestId, malicious);
  if (flags.length) {
    assert.equal(JSON.parse(result.out).requestId, malicious);
    assert.equal(JSON.parse(result.out).currencyOut.symbol, malicious);
    assert.doesNotMatch(result.out, /Route Summary/);
    return;
  }
  const footer = result.out.split('\n=== Route Summary ===\n')[1];
  assert.equal(footer.split('\n').length, 2);
  assert.equal(footer.endsWith('\n'), true);
  assert.ok(footer.includes('Output: 9.9 \\u001b[2J\\u001b[HFORGED\\u000aLINE'));
  assert.ok(footer.includes('requestId: \\u001b[2J\\u001b[HFORGED\\u000aLINE'));
  assert.ok(footer.includes('\\ud82f\\udca0\\udb40\\udc01'));
});
test('CLI escapes terminal controls in upstream HTTP errors', async () => {
  const result = await cli(['status', '--id', 'test'], {
    fetchImpl: async () => new Response(JSON.stringify({ message: '\u001b[2J\u001b[HFORGED\nSUCCESS' }), { status: 400 }),
  });
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.equal(result.err, 'Error: Relay HTTP 400: \\u001b[2J\\u001b[HFORGED\\u000aSUCCESS\n');
  assert.doesNotMatch(result.err.slice(0, -1), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
});
const args = [ {}, { fromChain: 'base', toChain: 'polygon', amount: '10', fromToken: 'USDC' }, { fromChain: 'base', amount: '10', fromToken: 'USDC' }, { fromChain: 'base', amount: '10', fromToken: 'USDC' }, { fromChain: 'base', targetChain: 'polygon', amountPerWallet: '2', recipients: [USER] }, { requestId: 'test' } ];
for (const framed of [false, true]) test(`MCP initialize, notifications and every tool over ${framed ? 'Content-Length' : 'NDJSON'}`, async () => {
  const input = new PassThrough(), output = new PassThrough(); let result = '';
  output.on('data', c => { result += c; });
  const running = startMcpServer({ input, output, ...mockRelay() });
  const messages = [{ jsonrpc: '2.0', id: '你好', method: 'initialize', params: { protocolVersion: '2024-11-05' } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, ...TOOLS.map((tool, i) => ({ jsonrpc: '2.0', id: i + 3, method: 'tools/call', params: { name: tool.name, arguments: args[i] } }))];
  for (const m of messages) {
    const json = JSON.stringify(m), wire = Buffer.from(framed ? `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}` : json + '\n');
    for (let offset = 0; offset < wire.length; offset += 7) input.write(wire.subarray(offset, offset + 7));
  }
  input.end(); await running;
  const responses = framed ? result.split(/Content-Length: \d+\r\n\r\n/).filter(Boolean).map(s => JSON.parse(s)) : result.trim().split('\n').map(s => JSON.parse(s));
  assert.equal(responses.length, 8); assert.equal(responses[0].id, '你好');
  assert.equal(responses[0].result.protocolVersion, '2024-11-05');
  assert.equal(responses[1].result.tools.length, 6);
  for (const r of responses.slice(2)) assert.equal(r.result.isError, false);
});
test('MCP invalid messages, unknown methods and tool failures', async () => {
  assert.equal((await handleRpc({})).error.code, -32600);
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 1, method: 'unknown' })).error.code, -32601);
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bad' } })).result.isError, true);
  const input = new PassThrough(), output = new PassThrough(); let text = ''; output.on('data', c => { text += c; });
  const done = startMcpServer({ input, output }); input.end('bad\n{"jsonrpc":"2.0","id":0,"method":"ping"}\n'); await done;
  const rows = text.trim().split('\n').map(s => JSON.parse(s)); assert.equal(rows[0].error.code, -32700); assert.deepEqual(rows[1].result, {});
});
test('MCP EOF ignores whitespace and preserves NDJSON versus truncated header framing', async () => {
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n';
  const parseError = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n';
  const truncated = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Truncated frame' } });
  const framedError = `Content-Length: ${Buffer.byteLength(truncated)}\r\n\r\n${truncated}`;
  for (const [wire, expected] of [
    ['{"jsonrpc":"2.0","id":1,"method":"ping"}\n   ', ping],
    ['{"jsonrpc":"2.0","id":1,"method":"ping"}', ping],
    ['bad', parseError],
    ['Content-Length: 10\r\n', framedError],
    ['Content-Length: 10', framedError],
    [' conTent-Len ', framedError],
    ['X-Test: yes', framedError],
    ['Content-Length: 10\r\n\r\n', framedError],
  ]) {
    const input = new PassThrough(), output = new PassThrough(); let result = '';
    output.on('data', c => { result += c; });
    const done = startMcpServer({ input, output });
    input.end(wire); await done;
    assert.equal(result, expected, `unexpected EOF response for ${JSON.stringify(wire)}`);
  }
});
test('all CLI commands and flags through injectable transport', async () => {
  for (const argv of [ ['--help'], ['--version'], ['chains', '--json'], ['quote', '--from', 'base', '--to', 'polygon', '--token', 'USDC', '--amount', '10', '--json'], ['polymarket', '--from', 'base', '--token', 'USDC', '--amount', '10', '--no-gas', '--json'], ['hyperliquid', '--from', 'base', '--token', 'USDC', '--amount', '10', '--mode', 'arbitrum_usdc', '--json'], ['refuel', '--from', 'base', '--token', 'USDC', '--to', 'polygon', '--amount-per-wallet', '2', '--recipients', USER, '--json'], ['status', '--request-id', 'test', '--json'] ]) {
    let out = '', err = '';
    const code = await runCli(argv, { ...mockRelay(), stdout: { write: s => { out += s; } }, stderr: { write: s => { err += s; } } });
    assert.equal(code, 0, err); assert.equal(err, ''); assert.ok(out);
    if (argv.includes('--json')) assert.ok(JSON.parse(out));
  }
});
test('CLI executable subprocess and invalid options exit status', async () => {
  for (const flag of ['--help', '--version', 'chains']) { const r = spawnSync(process.execPath, ['bin/omniroute.js', flag], { encoding: 'utf8' }); assert.equal(r.status, 0); assert.equal(r.stderr, ''); assert.ok(r.stdout); }
  for (const argv of [['unknown'], ['quote', '--from'], ['chains', '--oops'], ['quote', '--amount', '1', '--amount', '2']]) assert.equal(await runCli(argv, { stdout: { write() {} }, stderr: { write() {} } }), 1);
});
test('MCP frame limits and truncated input fail without tool execution', async () => {
  for (const wire of ['Content-Length: 1048577\r\n\r\n', 'Content-Length: 100\r\n\r\n{}', 'Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}']) {
    const input = new PassThrough(), output = new PassThrough(); let data = '';
    output.on('data', c => { data += c; });
    const done = startMcpServer({ input, output }); input.end(wire); await done;
    assert.ok(data.includes('"code":-32700'));
  }
});

test('fragmented 1 MiB NDJSON uses linear buffer copying', async t => {
  const input = new PassThrough(), output = new PassThrough(); let result = '';
  output.on('data', c => { result += c; });
  const done = startMcpServer({ input, output });
  const size = 1024 * 1024;
  const prefix = '{"jsonrpc":"2.0","id":1,"method":"ping","padding":"';
  const wire = Buffer.from(prefix + 'x'.repeat(size - Buffer.byteLength(prefix) - 2) + '"}');
  let copied = 0;
  const concat = Buffer.concat, copy = Buffer.prototype.copy;
  const concatMock = t.mock.method(Buffer, 'concat', function (list, ...args) {
    copied += list.reduce((sum, b) => sum + b.length, 0);
    return concat.call(this, list, ...args);
  });
  const copyMock = t.mock.method(Buffer.prototype, 'copy', function (target, offset, start = 0, end = this.length) {
    copied += end - start;
    return copy.call(this, target, offset, start, end);
  });
  try {
    for (let offset = 0; offset < wire.length; offset += 64) input.write(wire.subarray(offset, offset + 64));
    input.end();
  } finally {
    concatMock.mock.restore(); copyMock.mock.restore();
  }
  await done;
  assert.deepEqual(JSON.parse(result), { jsonrpc: '2.0', id: 1, result: {} });
  assert.ok(copied <= size * 4, 'copied bytes must remain proportional to input: ' + copied);
});
test('MCP accepts MIME headers before Content-Length across arbitrary chunk boundaries', async () => {
  for (const chunkSize of [1, 7, 65536]) {
    const input = new PassThrough(), output = new PassThrough(); let result = '';
    output.on('data', c => { result += c; });
    const done = startMcpServer({ input, output });
    const frames = [1, 2].map(id => {
      const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'ping', text: '你好' });
      return 'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nX-Test: yes\r\ncontent-length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body;
    }).join('');
    const wire = Buffer.from(frames);
    for (let offset = 0; offset < wire.length; offset += chunkSize) input.write(wire.subarray(offset, offset + chunkSize));
    input.end(); await done;
    const responses = result.split(/Content-Length: \d+\r\n\r\n/).filter(Boolean).map(s => JSON.parse(s));
    assert.deepEqual(responses, [1, 2].map(id => ({ jsonrpc: '2.0', id, result: {} })));
  }
});

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const pingWire = id => JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n';
for (const framed of [false, true]) test(`MCP pauses unread output and resumes ordered responses (${framed ? 'framed' : 'NDJSON'})`, { timeout: 2000 }, async () => {
  const input = new PassThrough(), output = new PassThrough({ highWaterMark: 1 });
  let writes = 0;
  const original = output.write.bind(output);
  output.write = (...args) => { writes++; return original(...args); };
  const done = startMcpServer({ input, output });
  input.end(Array.from({ length: 64 }, (_, id) => {
    const json = pingWire(id).trim();
    return framed ? `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}` : json + '\n';
  }).join(''));
  await nextTurn();
  assert.equal(writes, 1, 'no subsequent response may be written before drain');
  assert.equal(input.isPaused(), true);
  assert.ok(output.writableLength < 128);
  let result = '';
  output.on('data', chunk => { result += chunk; });
  await done;
  const responses = framed ? result.split(/Content-Length: \d+\r\n\r\n/).filter(Boolean).map(JSON.parse) : result.trim().split('\n').map(JSON.parse);
  assert.deepEqual(responses.map(r => r.id), Array.from({ length: 64 }, (_, id) => id));
  assert.equal(output.listenerCount('drain'), 0);
});
test('MCP rejects a 1000-request chunk without waiting for unread output', { timeout: 2000 }, async () => {
  const input = new PassThrough(), output = new PassThrough({ highWaterMark: 1 });
  const done = startMcpServer({ input, output });
  input.end(Array.from({ length: 1000 }, (_, id) => pingWire(id)).join(''));
  await done;
  assert.ok(output.writableLength < 256);
  const response = JSON.parse(output.read().toString());
  assert.match(response.error.message, /Too many pending requests/);
  assert.equal(input.listenerCount('data'), 0);
});
for (const failure of ['close', 'error']) test(`MCP releases a drain wait on output ${failure}`, { timeout: 2000 }, async () => {
  const input = new PassThrough(), output = new PassThrough({ highWaterMark: 1 });
  const done = startMcpServer({ input, output });
  const rejected = assert.rejects(done, failure === 'close' ? /output closed/ : /broken output/);
  input.end(pingWire(1) + pingWire(2));
  await nextTurn();
  assert.equal(input.isPaused(), true);
  output.destroy(failure === 'error' ? new Error('broken output') : undefined);
  await rejected;
  assert.equal(output.listenerCount('drain'), 0);
  assert.equal(input.listenerCount('data'), 0);
});

test('CLI inline flags support aliases, equals in values, and canonical duplicate errors', async () => {
  const m = mockRelay();
  assert.equal((await cli(['quote', '--source-chain=base', '--to=polygon', '--amount=1', '--json'], m)).code, 0);
  assert.equal(m.calls[0].payload.originChainId, 8453);
  const status = mockRelay();
  assert.equal((await cli(['status', '--id=a=b', '--json'], status)).code, 0);
  assert.ok(status.calls[0].url.endsWith('requestId=a%3Db'));
  for (const args of [['--from=base', '--source-chain', 'base'], ['--from', 'base', '--source-chain=base']]) assert.match((await cli(['quote', ...args])).err, /Duplicate option: --from/);
  for (const flag of ['--json=true', '--no-gas=false']) assert.match((await cli(['polymarket', flag])).err, /Unknown option/);
  assert.match((await cli(['quote', '--source-chain='])).err, /Missing value for --from/);
});
test('CLI required options fail explicitly before network and version is 1.3.0', async () => {
  const required = { quote: ['from', 'to', 'amount'], polymarket: ['from', 'amount'], hyperliquid: ['from', 'amount'], refuel: ['from', 'to', 'amount-per-wallet', 'recipients'], status: ['request-id'] };
  for (const [command, flags] of Object.entries(required)) for (const missing of flags) {
    const m = mockRelay();
    const r = await cli([command, ...flags.filter(f => f !== missing).map(f => `--${f}=value`)], m);
    assert.equal(r.err, `Error: Missing required option: --${missing}\n`);
    assert.equal(m.calls.length, 0);
  }
  assert.equal((await cli(['--version'])).out, '1.3.0\n');
  assert.match((await cli(['--help'])).out, /1\.3\.0/);
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })).result.serverInfo.version, '1.3.0');
});
test('NDJSON bare-LF colon line returns parse error without waiting for EOF or headers', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const done = startMcpServer({ input, output });
  const received = []; output.on('data', chunk => received.push(String(chunk)));
  input.write('foo: bar\n');
  // Allow queued RPC work to run while keeping the input stream open.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 1);
  assert.equal(JSON.parse(received[0]).error.code, -32700);
  input.end('{"jsonrpc":"2.0","id":7,"method":"ping"}\n');
  await done;
  assert.equal(JSON.parse(received[1]).id, 7);
});
