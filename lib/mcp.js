import fs from 'node:fs'
import path from 'node:path'
import { createToolCatalog, MCP_TOOL_NAMES } from './tools.js'

export const MCP_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18'])
export const MCP_LIMITS = Object.freeze({ inputBytes: 1024 * 1024, inFlight: 8 })
const serialNames = new Set(['veriscope_doctor', 'veriscope_gate_replay', 'veriscope_gate_check'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
const packageInfo = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const errorSchema = {
  type: 'object', required: ['schema_version', 'status', 'gate_passed', 'reason_codes', 'message'], additionalProperties: false,
  properties: { schema_version: { const: 'McpToolErrorV1' }, status: { const: 'REVIEW' }, gate_passed: { type: 'null' },
    reason_codes: { type: 'array', items: { type: 'string' } }, message: { type: 'string' } },
}

// This validator covers the fixed catalog's input-schema vocabulary. It is not
// exposed as a general JSON Schema implementation and never coerces arguments.
export function validToolArguments(value, schema, depth = 0) {
  if (depth > 32 || schema === false) return false
  if (schema === true) return true
  if (!object(schema)) return false
  if (schema.oneOf && schema.oneOf.filter(s => validToolArguments(value, s, depth + 1)).length !== 1) return false
  if (schema.anyOf && !schema.anyOf.some(s => validToolArguments(value, s, depth + 1))) return false
  if (schema.allOf && !schema.allOf.every(s => validToolArguments(value, s, depth + 1))) return false
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) return false
  if (schema.enum && !schema.enum.some(v => JSON.stringify(value) === JSON.stringify(v))) return false
  if (schema.type) {
    const matches = type => type === 'object' ? object(value) : type === 'array' ? Array.isArray(value)
      : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : type === 'null' ? value === null : typeof value === type
    if (!(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matches)) return false
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) return false
  }
  if (typeof value === 'string') {
    const length = [...value].length
    if ((schema.minLength !== undefined && length < schema.minLength) || (schema.maxLength !== undefined && length > schema.maxLength)) return false
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return false
  }
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) return false
    if (schema.items && !value.every(v => validToolArguments(v, schema.items, depth + 1))) return false
  }
  if (object(value)) {
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) { if (!validToolArguments(entry, schema.properties[key], depth + 1)) return false }
      else if (schema.additionalProperties === false) return false
      else if (object(schema.additionalProperties) && !validToolArguments(entry, schema.additionalProperties, depth + 1)) return false
    }
  }
  return true
}

function toolError(code, message) {
  return { content: [{ type: 'text', text: message }], isError: true,
    structuredContent: { schema_version: 'McpToolErrorV1', status: 'REVIEW', gate_passed: null, reason_codes: [code], message } }
}
function executionFailed(name, value) {
  if (name === 'veriscope_gate_check') return (value.execution?.errors ?? []).length > 0
  if (name === 'veriscope_gate_replay') {
    const business = new Set(['MISSING_POSITIVE_METRICS', 'POSITIVE_CONTEXT_UNVERIFIED', 'NO_VALID_MODEL', 'BASELINE_MISSING_POSITIVE_METRICS', 'BASELINE_POSITIVE_CONTEXT_UNVERIFIED', 'BASELINE_NO_VALID_MODEL'])
    return (value.execution?.errors ?? []).some(item => !business.has(item.code))
  }
  if (name === 'veriscope_doctor') return (value.items ?? []).some(item => item.status === 'fail')
  const faults = new Set(['INVALID_ARGUMENT', 'INVALID_THRESHOLD', 'INVALID_RUN_ID', 'BASELINE_REFERENCE_INVALID', 'INVALID_CONFIGURATION', 'INVALID_STATE_DIR', 'STATE_DIR_REQUIRED', 'STATE_PATH_ESCAPE', 'RECORD_PERMISSION', 'RECORD_OR_SOURCE_MISSING', 'CANCELLED', 'PYTHON_NOT_FOUND', 'PYTHON_UNAVAILABLE', 'STATE_WRITE_FAILED', 'BUILTIN_POLICY_ARGUMENT'])
  return (value.reason_codes ?? []).some(code => faults.has(code))
}

/** Start a stdio server. The optional catalog is only for local protocol tests. */
export function createMcpServer({ input = process.stdin, output = process.stdout, error = process.stderr, env = process.env, catalog } = {}) {
  const fixedEnv = Object.freeze({ ...env })
  const registry = catalog ?? createToolCatalog({ env: fixedEnv, requireExplicitStateDir: true })
  const tools = new Map(registry.tools.filter(tool => MCP_TOOL_NAMES.includes(tool.name)).map(tool => [tool.name, tool]))
  const inFlight = new Map(), jobs = new Set()
  let phase = 'new', serialTail = Promise.resolve(), stopped = false, closing, pending = Buffer.alloc(0), discarding = false
  let resolveClosed
  const closed = new Promise(resolve => { resolveClosed = resolve })
  const diagnostic = message => { try { error.write(message + '\n') } catch {} }
  const drain = () => { if (!stopped) input.resume?.() }
  const write = message => {
    if (stopped || output.destroyed) return
    try { if (!output.write(JSON.stringify(message) + '\n')) input.pause?.() } catch { void close() }
  }
  const fault = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })
  const result = (id, value) => write({ jsonrpc: '2.0', id, result: value })

  async function invoke(tool, args, controller) {
    if (controller.signal.aborted) return
    const state = fixedEnv.VERISCOPE_STATE_DIR
    if (typeof state !== 'string' || !state.trim() || state.includes('\0') || !path.isAbsolute(state)) {
      return toolError('INVALID_STATE_DIR', '待复核：MCP 必须显式配置非空绝对路径 VERISCOPE_STATE_DIR；未读取或写入默认状态目录。')
    }
    try {
      // No caller-supplied session identity is forwarded or manufactured.
      const value = await tool.call(args, { signal: controller.signal })
      if (!object(value)) return toolError('INVALID_TOOL_RESULT', '待复核：工具返回的结构无效，请保留记录并核查本地安装。')
      return { content: [{ type: 'text', text: tool.render(value) }], structuredContent: value, isError: executionFailed(tool.name, value) }
    } catch {
      // Never reflect thrown messages, arguments, environment values or keys.
      diagnostic('VeriScope MCP：本地工具执行异常；未自动重试。')
      return toolError('TOOL_EXECUTION_FAILED', '待复核：本地工具执行异常；请核查配置、路径与权限。未自动重试。')
    }
  }

  function receive(message) {
    if (stopped) return
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
      || (Object.hasOwn(message, 'id') && !validId(message.id))
      || (Object.hasOwn(message, 'params') && !object(message.params))) {
      fault(object(message) && validId(message.id) ? message.id : null, -32600, '无效的 JSON-RPC 请求。'); return
    }
    const notification = !Object.hasOwn(message, 'id'), { id, method } = message, params = message.params ?? {}
    if (notification) {
      if (method === 'notifications/initialized' && phase === 'waiting') phase = 'ready'
      if (method === 'notifications/cancelled' && validId(params.requestId)) inFlight.get(params.requestId)?.abort()
      // Unknown notifications are ignored, as required by JSON-RPC.
      return
    }
    if (inFlight.has(id)) { fault(id, -32600, '请求编号仍在使用中。'); return }
    if (method === 'ping') { result(id, {}); return }
    if (method === 'initialize') {
      if (phase !== 'new') { fault(id, -32600, '初始化已完成或正在等待 initialized 通知。'); return }
      if (typeof params.protocolVersion !== 'string' || !params.protocolVersion || !object(params.capabilities)
        || !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        fault(id, -32602, '初始化参数须包含协议版本、capabilities 和 clientInfo。'); return
      }
      phase = 'waiting'
      result(id, { protocolVersion: MCP_PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: packageInfo.name, version: packageInfo.version },
        instructions: '离线核验已有归档。VeriScope 用 replay；已有逐条评分用 check 和显式策略，builtin doctor 不需要 Python。PASS 不证明事实正确，不授权发布；REVIEW 永不转为 PASS。MCP 不提供会话绑定或完成入口。' })
      return
    }
    if (phase !== 'ready') { fault(id, -32600, '请先完成 initialize 和 notifications/initialized。'); return }
    if (method === 'tools/list') {
      if (Object.keys(params).some(key => !['_meta', 'cursor'].includes(key)) || (params.cursor !== undefined && typeof params.cursor !== 'string') || params.cursor) {
        fault(id, -32602, '工具清单不支持游标；请省略 cursor。'); return
      }
      result(id, { tools: [...tools.values()].map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: { type: 'object', anyOf: [tool.outputSchema, errorSchema] } } : {}), annotations: tool.annotations })) })
      return
    }
    if (method !== 'tools/call') { fault(id, -32601, '不支持此方法。'); return }
    if (typeof params.name !== 'string' || !tools.has(params.name) || Object.keys(params).some(key => !['name', 'arguments', '_meta'].includes(key))
      || (Object.hasOwn(params, 'arguments') && !object(params.arguments))) { fault(id, -32602, '工具名称或调用参数结构无效。'); return }
    const tool = tools.get(params.name), args = params.arguments ?? {}
    if (!validToolArguments(args, tool.inputSchema)) { result(id, toolError('INVALID_ARGUMENT', '待复核：工具参数不符合声明的类型、范围或字段要求；不接受会话标识参数。')); return }
    if (inFlight.size >= MCP_LIMITS.inFlight) { fault(id, -32000, '在途请求已达上限 8；请等待完成或取消。'); return }
    const controller = new AbortController()
    inFlight.set(id, controller)
    const work = () => invoke(tool, args, controller)
    const job = (serialNames.has(tool.name) ? serialTail.then(work) : Promise.resolve().then(work))
      .then(value => { if (!controller.signal.aborted && !stopped && value) result(id, value) })
      .catch(() => { if (!controller.signal.aborted && !stopped) result(id, toolError('TOOL_EXECUTION_FAILED', '待复核：工具调用未完成。')) })
      .finally(() => { inFlight.delete(id); jobs.delete(job) })
    if (serialNames.has(tool.name)) serialTail = job
    jobs.add(job)
  }

  function line(bytes) {
    let message
    try { message = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)) }
    catch { fault(null, -32700, 'JSON 解析失败；请发送 UTF-8 编码的单行消息。'); return }
    receive(message)
  }
  function data(chunk) {
    if (stopped) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let start = 0
    for (let index = 0; index <= bytes.length; index++) {
      if (index < bytes.length && bytes[index] !== 10) continue
      const part = bytes.subarray(start, index), end = index < bytes.length
      if (!discarding && pending.length + part.length > MCP_LIMITS.inputBytes) {
        pending = Buffer.alloc(0); discarding = true
        fault(null, -32600, '单条消息超过 1 MiB 限制。')
      }
      if (!discarding && part.length) pending = Buffer.concat([pending, part])
      if (end) {
        if (!discarding) line(pending)
        pending = Buffer.alloc(0); discarding = false
      }
      start = index + 1
    }
  }
  const end = () => { if (pending.length) diagnostic('VeriScope MCP：输入在消息结束前关闭，未执行残缺消息。'); void close() }
  const streamError = () => { diagnostic('VeriScope MCP：标准流关闭，正在取消在途请求。'); void close() }
  function close() {
    if (closing) return closing
    stopped = true; input.off('data', data); input.off('end', end); input.off('error', streamError); input.pause?.()
    for (const controller of inFlight.values()) controller.abort()
    closing = (async () => {
      await Promise.allSettled([...jobs])
      try { registry.dispose?.() } catch { diagnostic('VeriScope MCP：清理本地服务时发生异常。') }
      output.off('error', streamError); output.off('drain', drain); resolveClosed()
    })()
    return closing
  }
  input.on('data', data); input.on('end', end); input.on('error', streamError); output.on('error', streamError); output.on('drain', drain)
  return { close, closed }
}

export async function runStdioMcp() {
  let server
  const stop = () => { void server?.close() }
  try {
    server = createMcpServer()
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
    await server.closed
  } catch {
    process.stderr.write('VeriScope MCP 启动失败；请核查本地安装。\n')
    process.exitCode = 1
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
  }
}
