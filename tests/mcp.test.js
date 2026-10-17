import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { temporary } from './helpers.js'
import { MCP_LIMITS } from '../lib/mcp.js'

const repo = fileURLToPath(new URL('../', import.meta.url))
const initialize = (id = 1, version = '2025-11-25') => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'local-protocol-test', version: '1' } } })
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
const cancel = id => ({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: '测试取消' } })

function start(t, { fake = false, env = {}, state = true } = {}) {
  const root = temporary(t), stateRoot = path.join(root, 'state'), childEnv = { ...process.env, ...env }
  delete childEnv.VERISCOPE_STATE_DIR
  if (state) childEnv.VERISCOPE_STATE_DIR = stateRoot
  Object.assign(childEnv, env)
  const child = spawn(process.execPath, [fake ? 'tests/fixtures/mcp-harness.mjs' : 'mcp.js'], { cwd: repo, env: childEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const messages = [], waiters = [], chunks = [], errors = []
  let pending = '', malformed, exited
  child.stdout.on('data', data => {
    chunks.push(data); pending += data.toString('utf8')
    let newline
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
      try { messages.push(JSON.parse(line)) } catch { malformed = line }
      for (const waiter of [...waiters]) if (waiter.check()) { clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve() }
    }
  })
  child.stderr.on('data', data => errors.push(data))
  const closed = new Promise(resolve => { child.once('close', (code, signal) => { exited = { code, signal }; resolve(exited) }) })
  const wait = predicate => new Promise((resolve, reject) => {
    const check = () => predicate(messages)
    if (check()) { resolve(); return }
    const waiter = { check, resolve, timer: setTimeout(() => reject(new Error(`MCP response timeout: ${JSON.stringify(messages)} / ${Buffer.concat(errors)}`)), 8000) }
    waiters.push(waiter)
  })
  t.after(async () => { child.stdin.end(); if (!exited) { await Promise.race([closed, delay(1000)]); if (!exited) child.kill() } for (const waiter of waiters) clearTimeout(waiter.timer) })
  return { child, messages, root, stateRoot, closed, wait, send(message) { child.stdin.write(JSON.stringify(message) + '\n') },
    async response(id) { await wait(values => values.some(value => value.id === id)); assert.equal(malformed, undefined, 'stdout must contain only JSON-RPC lines'); return messages.find(value => value.id === id) },
    async ready(version) { this.send(initialize(1, version)); const value = await this.response(1); this.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); return value },
    get stderr() { return Buffer.concat(errors).toString('utf8') }, get stdout() { return Buffer.concat(chunks).toString('utf8') } }
}

test('real MCP executable negotiates supported versions, advertises only four shared tools and side effects', async t => {
  const client = start(t)
  const handshake = await client.ready()
  assert.equal(handshake.result.protocolVersion, '2025-11-25')
  assert.equal(handshake.result.serverInfo.name, 'dsh-plugin-veriscope')
  assert.deepEqual(handshake.result.capabilities, { tools: { listChanged: false } })
  client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const list = (await client.response(2)).result.tools
  assert.deepEqual(list.map(item => item.name).sort(), ['veriscope_doctor', 'veriscope_gate_list', 'veriscope_gate_replay', 'veriscope_gate_status'])
  for (const tool of list) assert.equal(tool.annotations.readOnlyHint, ['veriscope_gate_list', 'veriscope_gate_status'].includes(tool.name))
  assert.equal(fs.existsSync(client.stateRoot), false, 'initialization and tools/list must not create state')
})

for (const [requested, expected] of [['2025-06-18', '2025-06-18'], ['2026-01-01', '2025-11-25']]) test(`MCP version ${requested} negotiates honestly`, async t => {
  const client = start(t); assert.equal((await client.ready(requested)).result.protocolVersion, expected)
})

test('real subprocess accepts fragmented UTF-8 and multiple newline messages without stdout noise', async t => {
  const client = start(t), request = initialize()
  request.params.clientInfo.name = '中文客户端'
  const buffer = Buffer.from(JSON.stringify(request) + '\n' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const split = buffer.indexOf(Buffer.from('中')) + 1
  client.child.stdin.write(buffer.subarray(0, split)); client.child.stdin.write(buffer.subarray(split, split + 1)); client.child.stdin.write(buffer.subarray(split + 1))
  await client.response(1)
  client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: '中文', method: 'ping' }) + '\n' + JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }) + '\n')
  assert.deepEqual((await client.response('中文')).result, {})
  assert.deepEqual((await client.response(3)).result, {})
  client.child.stdin.end(); assert.equal((await client.closed).code, 0)
  assert.equal(client.stderr, '')
})

test('protocol errors cover JSON syntax, invalid envelope, initialization, unknown method and call structure', async t => {
  const c = start(t)
  c.child.stdin.write('{bad\n')
  await c.wait(messages => messages.some(m => m.error?.code === -32700))
  c.send([]); await c.wait(messages => messages.some(m => m.error?.code === -32600))
  c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }); assert.equal((await c.response(2)).error.code, -32600)
  c.send({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }); assert.equal((await c.response(3)).error.code, -32602)
  await c.ready()
  c.send({ jsonrpc: '2.0', id: 4, method: 'not-supported' }); assert.equal((await c.response(4)).error.code, -32601)
  c.send(call(5, 'veriscope_gate_bind')); assert.equal((await c.response(5)).error.code, -32602)
  c.send({ ...call(6, 'veriscope_doctor'), params: { name: 'veriscope_doctor', arguments: [] } }); assert.equal((await c.response(6)).error.code, -32602)
  c.send(initialize(7)); assert.equal((await c.response(7)).error.code, -32600)
})

test('all four real MCP tools require explicit state without touching default storage', async t => {
  const c = start(t, { state: false }); await c.ready()
  const cases = [['veriscope_doctor', {}], ['veriscope_gate_list', {}], ['veriscope_gate_replay', { result_path: 'missing.json' }], ['veriscope_gate_status', { run_id: '11111111-1111-4111-8111-111111111111' }]]
  for (const [index, [name, args]] of cases.entries()) {
    c.send(call(index + 10, name, args)); const value = (await c.response(index + 10)).result
    assert.equal(value.isError, true); assert.equal(value.structuredContent.status, 'REVIEW'); assert.ok(value.structuredContent.reason_codes.includes('INVALID_STATE_DIR'))
  }
  assert.equal(fs.existsSync(c.stateRoot), false)
})

test('tool argument validation rejects forged session, wrong types, unknown fields and out of range thresholds before side effects', async t => {
  const c = start(t); await c.ready()
  const bad = [call(10, 'veriscope_doctor', { session_id: 'forged' }), call(11, 'veriscope_gate_replay', { result_path: 'x', faith: 1.1 }),
    call(12, 'veriscope_gate_replay', { result_path: 'x', ctx: '0.8' }), call(13, 'veriscope_gate_list', { limit: 1.5 }), call(14, 'veriscope_gate_status', {}), call(15, 'veriscope_gate_status', { run_id: 'bad-uuid' })]
  for (const request of bad) { c.send(request); assert.equal((await c.response(request.id)).result.isError, true) }
  assert.equal(fs.existsSync(c.stateRoot), false)
})

test('empty archive paths remain a service validation failure and never execute a gate', async t => {
  const upstream = temporary(t)
  fs.mkdirSync(path.join(upstream, 'scripts'))
  fs.writeFileSync(path.join(upstream, 'scripts/gate_replay.py'), '# validation must fail before this script is executed\n')
  const c = start(t, { env: { VERISCOPE_ROOT: upstream, VERISCOPE_PYTHON: process.execPath } }); await c.ready()
  c.send(call(2, 'veriscope_gate_replay', { result_path: '' }))
  const result = (await c.response(2)).result
  assert.equal(result.isError, true); assert.equal(result.structuredContent.status, 'REVIEW'); assert.equal(result.structuredContent.gate_passed, null)
  assert.ok(result.structuredContent.execution.errors.some(error => error.code === 'INVALID_ARGUMENT'))
  assert.equal(result.structuredContent.execution.process, null)
  assert.equal(result.structuredContent.execution.new_evaluation_model_calls, 0)
})

test('business FAIL and incomplete-metric REVIEW remain successful tool results, while a write failure preserves FAIL', async t => {
  const c = start(t, { fake: true }); await c.ready()
  for (const [id, input, status, isError] of [[2, 'fail', 'FAIL', false], [3, 'review', 'REVIEW', false], [4, 'fail-write-error', 'FAIL', true]]) {
    c.send(call(id, 'veriscope_gate_replay', { result_path: input }))
    const result = (await c.response(id)).result
    assert.equal(result.structuredContent.status, status); assert.equal(result.isError, isError); assert.equal(result.structuredContent.execution.session_id, null)
  }
})

test('doctor and replay serialize, while status and ping finish without waiting for replay', async t => {
  const c = start(t, { fake: true }); await c.ready()
  c.send(call(2, 'veriscope_gate_replay', { result_path: 'slow' })); c.send(call(3, 'veriscope_doctor'))
  c.send(call(4, 'veriscope_gate_status')); c.send({ jsonrpc: '2.0', id: 5, method: 'ping' })
  await c.response(4); await c.response(5)
  assert.equal(c.messages.some(m => m.id === 2 || m.id === 3), false)
  await c.response(3)
  assert.equal(c.messages.find(m => m.id === 3).result.structuredContent.maximum, 1)
  assert.deepEqual(c.messages.find(m => m.id === 3).result.structuredContent.events, ['veriscope_gate_replay:start', 'veriscope_gate_replay:done', 'veriscope_doctor:start', 'veriscope_doctor:done'])
})

test('cancel aborts a running replay, skips queued doctor and never responds to cancelled request IDs', async t => {
  const c = start(t, { fake: true }); await c.ready()
  c.send(call(2, 'veriscope_gate_replay', { result_path: 'slow' })); c.send(call(3, 'veriscope_doctor'))
  c.send(call(4, 'veriscope_gate_list')); assert.ok((await c.response(4)).result.structuredContent.events.includes('veriscope_gate_replay:start'))
  c.send(cancel(3)); c.send(cancel(2)); c.send(cancel('unknown'))
  await delay(80); c.send(call(5, 'veriscope_gate_list')); const value = (await c.response(5)).result.structuredContent
  assert.ok(value.events.includes('veriscope_gate_replay:cancelled'))
  assert.equal(value.events.includes('veriscope_doctor:start'), false)
  assert.equal(c.messages.some(m => m.id === 2 || m.id === 3), false)
})

test('eight in-flight requests are bounded without blocking ping or cancellation', async t => {
  const c = start(t, { fake: true }); await c.ready()
  for (let id = 2; id <= 10; id++) c.send(call(id, 'veriscope_gate_replay', { result_path: 'slow' }))
  assert.equal((await c.response(10)).error.code, -32000)
  c.send({ jsonrpc: '2.0', id: 11, method: 'ping' }); assert.deepEqual((await c.response(11)).result, {})
  for (let id = 2; id <= 9; id++) c.send(cancel(id))
})

test('oversized and invalid UTF-8 lines are rejected, then next valid message is recoverable', async t => {
  const c = start(t); await c.ready()
  c.child.stdin.write('x'.repeat(MCP_LIMITS.inputBytes + 1) + '\n')
  await c.wait(messages => messages.some(m => m.error?.code === -32600))
  c.child.stdin.write(Buffer.from([0xff, 10])); await c.wait(messages => messages.some(m => m.error?.code === -32700))
  c.send({ jsonrpc: '2.0', id: 2, method: 'ping' }); assert.deepEqual((await c.response(2)).result, {})
})

test('EOF cancels actual child runner and exits without a surviving subprocess', async t => {
  const c = start(t, { fake: true }); await c.ready()
  c.send(call(2, 'veriscope_gate_replay', { result_path: 'child' })); await delay(200); c.child.stdin.end()
  assert.equal((await c.closed).code, 0)
  const record = JSON.parse(c.stderr.trim()), childRecord = record.events.find(value => /^child:\d+:cancelled$/.test(value))
  assert.ok(childRecord, c.stderr)
  const pid = Number(childRecord.split(':')[1]); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(c.messages.some(message => message.id === 2), false)
})

test('tool exceptions never disclose arbitrary exception text or secret environment values', async t => {
  const secret = 'never-print-this-secret', c = start(t, { fake: true, env: { TEST_SECRET: secret } }); await c.ready()
  c.send(call(2, 'veriscope_gate_replay', { result_path: 'throw' })); assert.equal((await c.response(2)).result.isError, true)
  c.child.stdin.end(); await c.closed
  assert.equal((c.stdout + c.stderr).includes(secret), false)
})
