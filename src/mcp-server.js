import { TOOLS, callTool } from './service.js';
const MAX_PENDING_REQUESTS = 64;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export async function handleRpc(message, options = {}) {
  const valid = message && !Array.isArray(message) && message.jsonrpc === '2.0' && typeof message.method === 'string' && (message.id === undefined || message.id === null || typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id)));
  if (!valid) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  if (message.id === undefined) return null;
  const response = result => ({ jsonrpc: '2.0', id: message.id, result });
  const error = (code, text) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  if (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) return error(-32602, 'Invalid params');
  switch (message.method) {
    case 'initialize': return response({ protocolVersion: versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : versions[0], capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } }, serverInfo: { name: 'omniroute-bridge-mcp', version: '1.3.1' }, instructions: 'Read-only unsigned quotes. Always show executeUrl to the user for 1-click browser wallet signing. All routes include a 30 bps integrator fee. Never execute a preview quote.' });
    case 'ping': return response({});
    case 'tools/list': return response({ tools: TOOLS });
    case 'resources/list': return response({ resources: [] });
    case 'prompts/list': return response({ prompts: [] });
    case 'tools/call': {
      if (typeof message.params?.name !== 'string') return error(-32602, 'Tool name is required');
      try { const result = await callTool(message.params.name, message.params.arguments ?? {}, options); return response({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false }); }
      catch (e) { return response({ content: [{ type: 'text', text: e.message }], isError: true }); }
    }
    default: return error(-32601, 'Method not found');
  }
}
export function startMcpServer({ input = process.stdin, output = process.stdout, ...options } = {}) {
  // Geometric growth and incremental scanning keep fragmented input linear.
  let buffer = Buffer.alloc(1024), start = 0, end = 0, scan = 0;
  let mode = 'line', bodyLength = 0, pending = Promise.resolve(), failed = false;
  let queued = 0, stopped = false, cancelDrain;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const finish = error => {
    if (stopped) return;
    stopped = true;
    input.pause?.();
    input.removeListener('data', consume);
    input.removeListener('end', onEnd);
    input.removeListener('error', onError);
    output.removeListener('error', onError);
    output.removeListener('close', onClose);
    cancelDrain?.();
    buffer = Buffer.alloc(0);
    error ? rejectDone(error) : resolveDone();
  };
  const onError = error => finish(error);
  const onClose = () => finish(new Error('MCP output closed before responses completed'));
  const encode = (response, framed) => {
    const json = JSON.stringify(response);
    return framed ? `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}` : json + '\n';
  };
  const send = async (response, framed) => {
    if (!response || stopped) return;
    if (output.write(encode(response, framed)) !== false) return;
    input.pause?.();
    await new Promise(resolve => {
      const drained = () => {
        output.removeListener('drain', drained);
        cancelDrain = undefined;
        resolve();
      };
      cancelDrain = drained;
      output.once('drain', drained);
      if (stopped) drained();
    });
    if (!stopped) input.resume?.();
  };
  const invalid = (message = 'Parse error') => ({ jsonrpc: '2.0', id: null, error: { code: -32700, message } });
  // A terminal error is the last write; completion never waits on an unread peer.
  const fail = (framed, message) => {
    failed = true;
    if (!cancelDrain) {
      try { output.write(encode(invalid(message), framed)); }
      catch (error) { finish(error); return; }
    }
    finish();
    start = end = scan = 0;
  };
  const enqueue = (body, framed, error) => {
    if (stopped) return;
    if (queued >= MAX_PENDING_REQUESTS) { fail(framed, 'Too many pending requests (maximum 64)'); return; }
    queued++;
    pending = pending.then(async () => {
      if (stopped) return;
      let message;
      try { message = error ? null : JSON.parse(body); }
      catch { await send(invalid(), framed); return; }
      await send(error ? invalid(error) : await handleRpc(message, options), framed);
    }).finally(() => { queued--; });
    pending.catch(onError);
  };
  const advance = count => {
    start += count;
    if (start === end) start = end = 0;
    scan = start;
  };
  const consume = chunk => {
    if (failed) return;
    if (end + chunk.length > buffer.length) {
      const live = end - start;
      if (live + chunk.length <= buffer.length / 2) {
        buffer.copy(buffer, 0, start, end);
      } else {
        let capacity = buffer.length * 2;
        while (capacity < live + chunk.length) capacity *= 2;
        const next = Buffer.allocUnsafe(capacity);
        buffer.copy(next, 0, start, end);
        buffer = next;
      }
      scan -= start; end = live; start = 0;
    }
    chunk.copy(buffer, end); end += chunk.length;
    while (!stopped && start < end) {
      if (mode === 'body') {
        if (end - start < bodyLength) break;
        enqueue(buffer.toString('utf8', start, start + bodyLength), true);
        if (stopped) break;
        advance(bodyLength); mode = 'line';
      } else if (mode === 'headers') {
        const boundary = buffer.subarray(0, end).indexOf('\r\n\r\n', scan);
        if (boundary < 0) {
          scan = Math.max(start, end - 3);
          if (end - start > 8192 + 3) fail(true, 'Header too large');
          break;
        }
        if (boundary - start > 8192) { fail(true, 'Header too large'); break; }
        const header = buffer.toString('utf8', start, boundary);
        const lengths = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
        bodyLength = lengths.length === 1 ? Number(lengths[0][1]) : NaN;
        if (!Number.isSafeInteger(bodyLength) || bodyLength < 1 || bodyLength > MAX_MESSAGE_BYTES) { fail(true, 'Invalid Content-Length'); break; }
        advance(boundary + 4 - start); mode = 'body';
      } else {
        const newline = buffer.subarray(0, end).indexOf(10, scan);
        if (newline < 0) {
          scan = end;
          if (end - start > MAX_MESSAGE_BYTES) fail(false, 'Message too large');
          break;
        }
        const line = buffer.toString('utf8', start, newline);
        // Any MIME field can precede Content-Length; JSON cannot start this way.
        if ((line.endsWith('\r') && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/.test(line)) || /^content-length\s*:/i.test(line)) {
          mode = 'headers'; scan = start;
          continue;
        }
        if (newline - start > MAX_MESSAGE_BYTES) { fail(false, 'Message too large'); break; }
        else if (line.trim()) enqueue(line.trim(), false);
        if (stopped) break;
        advance(newline + 1 - start);
      }
    }
  };
  const onEnd = () => {
    if (!failed) {
      if (mode !== 'line') enqueue(null, true, 'Truncated frame');
      else if (end > start) {
        const rawTail = buffer.toString('utf8', start, end), trimmed = rawTail.trim();
        if (trimmed) {
          if (/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/.test(rawTail) || 'content-length:'.startsWith(trimmed.toLowerCase())) enqueue(null, true, 'Truncated frame');
          else enqueue(trimmed, false);
        }
      }
    }
    pending.then(() => finish(), onError);
  };
  input.on('error', onError);
  output.on('error', onError);
  output.on('close', onClose);
  input.on('end', onEnd);
  input.on('data', consume);
  return done;
}
