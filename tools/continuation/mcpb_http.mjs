// T259: narrow MCP 2025-03-26 Streamable HTTP client. No retries, GET listener, or daemon.
// Credentials stay in this operation's closure; no response/error text is exposed to callers.
export const PROTOCOL_VERSION = '2025-03-26';
const MAX_BYTES = 256 * 1024;
const fail = (code) => { throw new Error(code); };

function responseFrom(value, id) {
  const messages = Array.isArray(value) ? value : [value];
  if (messages.length > 32) fail('protocol_invalid');
  let found;
  for (const message of messages) {
    if (!message || message.jsonrpc !== '2.0') fail('protocol_invalid');
    if (message.method) {
      if (Object.hasOwn(message, 'id')) fail('server_request_unsupported');
      continue; // notifications are not evidence of the requested operation's result
    }
    if (message.id !== id || found) fail('protocol_invalid');
    if (Object.hasOwn(message, 'error')) fail('rpc_error');
    if (!Object.hasOwn(message, 'result')) fail('protocol_invalid');
    found = message;
  }
  return found;
}

async function readResponse(response, id) {
  const kind = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (!['application/json', 'text/event-stream'].includes(kind) || !response.body) fail('protocol_invalid');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '', skipLF = false;
  const sseLines = (chunk) => {
    let output = '';
    for (const char of chunk) {
      if (skipLF) { skipLF = false; if (char === '\n') continue; }
      if (char === '\r') { output += '\n'; skipLF = true; } else output += char;
    }
    return output;
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      let decoded;
      if (!chunk.done) {
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) fail('response_limit');
        decoded = decoder.decode(chunk.value, { stream: true });
      } else decoded = decoder.decode();
      text += kind === 'text/event-stream' ? sseLines(decoded) : decoded;
      if (kind === 'text/event-stream') {
        let boundary;
        while ((boundary = text.indexOf('\n\n')) >= 0) {
          const frame = text.slice(0, boundary);
          text = text.slice(boundary + 2);
          const data = frame.split('\n').filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
          if (data) {
            const result = responseFrom(JSON.parse(data), id);
            if (result) return result.result;
          }
        }
      }
      if (chunk.done) break;
    }
    if (kind === 'application/json') {
      const result = responseFrom(JSON.parse(text), id);
      if (result) return result.result;
    }
    fail('protocol_invalid');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export function endpointFrom(value) {
  let url;
  try { url = new URL(value); } catch { fail('configuration_invalid'); }
  // Literal IPs avoid DNS-based credential forwarding. localhost is deliberately unsupported.
  if (!['127.0.0.1', '[::1]'].includes(url.hostname)
    || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/mcp'
    || url.username || url.password || url.search || url.hash) fail('configuration_invalid');
  return url.href;
}

/** One explicit operation, with its own MCP connection session (not a DSH session). */
export function createChannel(endpoint, token) {
  endpoint = endpointFrom(endpoint);
  let sequence = 0, session = null, initialized = false;
  async function post(method, params, timeoutMs, notification = false) {
    const id = ++sequence;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'X-Codex-Bridge-Token': token };
      if (initialized) headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
      if (session) headers['Mcp-Session-Id'] = session;
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers,
        signal: controller.signal,
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }) });
      if (notification) {
        await response.body?.cancel();
        if (response.status !== 202) fail('protocol_invalid');
        return null;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        fail('http_error');
      }
      const result = await readResponse(response, id);
      if (method === 'initialize') {
        const returned = response.headers.get('Mcp-Session-Id');
        if (returned !== null) {
          if (!/^[\x21-\x7e]{1,1024}$/.test(returned)) fail('protocol_invalid');
          session = returned;
        }
      }
      return result;
    } catch (error) {
      const codes = ['protocol_invalid', 'server_request_unsupported', 'rpc_error', 'response_limit', 'http_error'];
      fail(controller.signal.aborted ? 'timeout'
        : (codes.includes(error?.message) ? error.message : 'transport_error'));
    } finally { clearTimeout(timer); }
  }
  return {
    async initialize(timeoutMs) {
      const result = await post('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {},
        clientInfo: { name: 'agent-relay-mcpb', version: '0.1.0' } }, timeoutMs);
      if (result?.protocolVersion !== PROTOCOL_VERSION || !result?.capabilities?.tools) fail('protocol_unsupported');
      initialized = true;
      await post('notifications/initialized', {}, timeoutMs, true);
    },
    listTools: (timeoutMs) => post('tools/list', {}, timeoutMs),
    call: (name, args, timeoutMs) => post('tools/call', { name, arguments: args }, timeoutMs),
  };
}

/** Only bounded structured JSON. Never forward arbitrary text or an upstream error message. */
export function toolObject(result) {
  if (!result || result.isError === true) fail('tool_error');
  let value = result.structuredContent;
  if (!value) {
    if (!Array.isArray(result.content) || result.content.length !== 1
      || result.content[0].type !== 'text') fail('tool_result_invalid');
    value = JSON.parse(result.content[0].text);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('tool_result_invalid');
  return value;
}
