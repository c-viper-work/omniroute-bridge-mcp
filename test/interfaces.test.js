import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { startMcpServer, handleRpc, TOOLS } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { USER, mockRelay } from './helpers.js';
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
