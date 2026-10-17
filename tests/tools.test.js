import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createToolCatalog, MCP_TOOL_NAMES, toolParameters } from '../lib/tools.js'
import { toValueSpec, reportSchemaSpec, statusSchemaSpec, managedSchemaSpec, utilitySchemaSpec } from '../lib/schema.js'
import { receiptFixture } from './fusion-helpers.js'

// Exercise the actual DSH adapter without installing an optional alpha host.
// Runtime compatibility is separately checked against the real ToolRuntime.
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools/package.json') return { url: new URL('./fixtures/dsh-tools-package.json', import.meta.url).href, shortCircuit: true }
  return specifier === '@deepseek-ai/dsh-tools'
    ? { url: 'data:text/javascript,export const defineTool = value => value', shortCircuit: true }
    : next(specifier, context)
} })
const { apply } = await import('../index.js')
hook.deregister()

function host({ failAfter = Infinity } = {}) {
  const tools = new Map(), disposed = [], events = new Map()
  return { tools, disposed, events, ctx: {
    get: () => undefined,
    tools: { register(value) {
      if (tools.size >= failAfter) throw new Error('registration failure')
      tools.set(value.name, value)
      return () => { disposed.push(value.name); tools.delete(value.name) }
    } },
    inject: () => ({ dispose() { disposed.push('bridge') } }),
    on(event, fn) { events.set(event, fn); return () => events.delete(event) },
  } }
}

test('the shared catalog exposes eight tools with a four-tool MCP subset and truthful write annotations', () => {
  const catalog = createToolCatalog({ env: {} })
  const names = catalog.tools.map(tool => tool.name)
  assert.equal(new Set(names).size, 8)
  assert.deepEqual(MCP_TOOL_NAMES, ['veriscope_doctor', 'veriscope_gate_replay', 'veriscope_gate_status', 'veriscope_gate_list'])
  for (const tool of catalog.tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'session_id'), false)
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'sessionId'), false)
    assert.equal(typeof tool.call, 'function'); assert.equal(typeof tool.render, 'function')
    assert.equal(tool.annotations.readOnlyHint, ['veriscope_gate_status', 'veriscope_gate_list'].includes(tool.name))
  }
  assert.ok(MCP_TOOL_NAMES.every(name => names.includes(name)))
  assert.equal(MCP_TOOL_NAMES.includes('veriscope_gate_bind'), false)
  assert.equal(MCP_TOOL_NAMES.includes('veriscope_gate_complete'), false)
  assert.doesNotMatch(catalog.tools.find(tool => tool.name === 'veriscope_gate_replay').description, /只读/)
  catalog.dispose()
})

test('DSH registration consumes the same names and parameter schemas without changing result DSL or card metadata', () => {
  const catalog = createToolCatalog({ env: {} }), h = host(), dispose = apply(h.ctx)
  assert.deepEqual([...h.tools.keys()], catalog.tools.map(tool => tool.name))
  for (const source of catalog.tools) {
    const registered = h.tools.get(source.name)
    assert.deepEqual(registered.parameters, toolParameters(source.inputSchema))
    assert.deepEqual(registered.output.schema, toValueSpec(source.outputSchema))
    assert.equal(typeof registered.output.presentationMeta, source.presentation === 'gate' ? 'function' : 'undefined')
  }
  assert.deepEqual(h.tools.get('veriscope_gate_replay').output.schema, reportSchemaSpec)
  assert.deepEqual(h.tools.get('veriscope_gate_status').output.schema, statusSchemaSpec)
  assert.deepEqual(h.tools.get('veriscope_gate_bind').output.schema, managedSchemaSpec)
  assert.deepEqual(h.tools.get('veriscope_doctor').output.schema, utilitySchemaSpec)
  assert.equal(h.tools.get('veriscope_gate_replay').parameters.result_path.required, true)
  assert.equal(h.tools.get('veriscope_gate_status').parameters.run_id.required, true)
  assert.equal(h.tools.get('veriscope_gate_export').parameters.format.required, true)
  assert.equal(h.tools.get('veriscope_gate_replay').parameters.faith.required, undefined)
  dispose(); catalog.dispose()
  assert.equal(h.tools.size, 0)
  assert.equal(h.disposed.includes('bridge'), true)
})

test('shared status dispatch propagates cancellation without introducing session parameters', async () => {
  const calls = [], controller = new AbortController()
  const statusService = { status: async (args, context) => { calls.push({ args, context }); return { current_verdict: 'REVIEW' } } }
  const catalog = createToolCatalog({ env: {}, statusService })
  const args = { run_id: '01234567-0123-4123-8123-0123456789ab', faith: .9, baseline_run_id: null }
  const value = await catalog.tools.find(tool => tool.name === 'veriscope_gate_status').call(args, { signal: controller.signal, sessionId: 'ignored' })
  assert.equal(value.current_verdict, 'REVIEW')
  assert.deepEqual(calls, [{ args, context: { signal: controller.signal } }])
  catalog.dispose()
})

test('DSH alpha bounds projection keeps canonical limits and service-side rejection before execution', async t => {
  const f = await receiptFixture(t), catalog = createToolCatalog(f.options)
  const tool = catalog.tools.find(item => item.name === 'veriscope_gate_replay')
  assert.equal(tool.inputSchema.properties.faith.minimum, 0)
  assert.equal(tool.inputSchema.properties.faith.maximum, 1)
  assert.equal(Object.hasOwn(toolParameters(tool.inputSchema).faith, 'minimum'), false)
  assert.equal(Object.hasOwn(toolParameters(tool.inputSchema).faith, 'maximum'), false)
  const count = f.calls.length
  const report = await tool.call({ result_path: f.input, faith: 1.1 })
  assert.equal(report.status, 'REVIEW'); assert.equal(report.execution.process, null)
  assert.ok(report.execution.errors.some(item => item.code === 'INVALID_ARGUMENT'))
  assert.equal(f.calls.length, count)
  catalog.dispose()
})

test('shared replay fixes the configured environment and records host identity only in execution', async t => {
  const f = await receiptFixture(t), catalog = createToolCatalog(f.options)
  const oldRoot = f.options.env.VERISCOPE_ROOT
  f.options.env.VERISCOPE_ROOT = 'changed after factory creation'
  const report = await catalog.tools.find(tool => tool.name === 'veriscope_gate_replay').call({ result_path: f.input }, { sessionId: 'host-session' })
  f.options.env.VERISCOPE_ROOT = oldRoot
  assert.equal(report.status, 'PASS')
  assert.equal(report.execution.session_id, 'host-session')
  assert.equal(report.session_id, undefined)
  assert.equal(report.execution.new_evaluation_model_calls, 0)
  const current = await catalog.statusService.status({ run_id: report.run_id })
  assert.equal(current.current_verdict, 'PASS')
  catalog.dispose()
})

test('managed dispatch ignores a fabricated sessionId and still requires the real host identity', async () => {
  const run_id = '01234567-0123-4123-8123-0123456789ab'
  const statusService = { status: async () => ({ integrity: 'VALID', freshness: 'FRESH', scope_digest: 'scope', current_verdict: 'PASS', gate_passed: true }) }
  const catalog = createToolCatalog({ env: {}, statusService })
  const bind = catalog.tools.find(tool => tool.name === 'veriscope_gate_bind')
  const args = { task_id: 'task', run_id }
  assert.equal((await bind.call(args, { sessionId: 'forged' })).reason_code, 'SESSION_REQUIRED_OR_CANCELLED')
  assert.equal((await bind.call(args, { execution: { agent: { session: { id: 'real' } } } })).reason_code, 'BOUND')
  catalog.dispose()
  assert.equal((await bind.call({ task_id: 'another', run_id }, { execution: { agent: { session: { id: 'real' } } } })).accepted, false)
})

test('DSH status preserves session metadata, policy and Chinese rendering through the shared catalog', async () => {
  const h = host(), dispose = apply(h.ctx)
  const tool = h.tools.get('veriscope_gate_status')
  const args = { run_id: 'invalid', faith: .9, ctx: .7, baseline_run_id: null }
  const value = await tool.execute(args, { agent: { session: { id: 'host-session' } } })
  assert.equal(value.current_verdict, 'REVIEW'); assert.equal(value.session_id, 'host-session')
  const metadata = tool.output.presentationMeta(args, value).veriscope
  assert.equal(metadata.session_id, 'host-session')
  assert.deepEqual(metadata.policy, { faith: .9, ctx: .7, baseline_run_id: null })
  assert.match(tool.output.render(args, value)[0].text, /当前状态：待复核/)
  dispose()
})

test('DSH reminder remains opt-in and partial registration is completely disposed', () => {
  const normal = host(), stop = apply(normal.ctx)
  assert.equal(normal.events.size, 0); stop()
  const reminding = host(), stopReminder = apply(reminding.ctx, { completionMode: 'remind' })
  assert.equal(typeof reminding.events.get('agent/turn-stopping'), 'function')
  stopReminder(); assert.equal(reminding.events.size, 0)
  const failing = host({ failAfter: 3 })
  assert.throws(() => apply(failing.ctx), /registration failure/)
  assert.equal(failing.tools.size, 0)
})
