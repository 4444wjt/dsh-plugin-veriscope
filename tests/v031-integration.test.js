import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import http from 'node:http'
import { setup } from './helpers.js'
import { receiptFixture } from './fusion-helpers.js'
import { createReplayService, renderReport } from '../lib/replay.js'
import { createExportService } from '../lib/export.js'
import { registerStatusBridge } from '../lib/bridge.js'

test('bad input diagnostics reach persisted replay and Chinese text without running Python or editing input', async t => {
  const f = setup(t), bytes = Buffer.from('{\r\n"summary": [\r\n}')
  fs.writeFileSync(f.input, bytes)
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, 'REVIEW'); assert.equal(report.gate_passed, null)
  assert.equal(f.calls.length, 0); assert.deepEqual(fs.readFileSync(f.input), bytes)
  const error = report.execution.errors.find(item => item.code === 'INVALID_JSON')
  assert.equal(error.diagnostic_source, 'input')
  assert.equal(error.diagnostic.line, 3); assert.equal(error.diagnostic.column, 1)
  assert.equal(error.diagnostic.position_basis, 'decoded_text_utf16')
  const stored = JSON.parse(fs.readFileSync(path.join(report.execution.artifacts_path, 'report.json'), 'utf8'))
  assert.deepEqual(stored.execution.errors.find(item => item.code === 'INVALID_JSON'), error)
  assert.match(renderReport(report), /输入归档发现异常位置：第 3 行，第 1 列/)
  assert.equal(fs.existsSync(path.join(report.execution.artifacts_path, 'receipt.json')), false)
})

test('bad baseline diagnostics identify the baseline and never replace it or call a model', async t => {
  const f = setup(t), baseline = path.join(f.root, 'baseline.json'), raw = '{"summary": ['
  fs.writeFileSync(baseline, raw)
  const report = await createReplayService(f.options).replay({ result_path: f.input, baseline })
  assert.equal(report.status, 'REVIEW')
  assert.equal(report.execution.errors.find(item => item.diagnostic)?.diagnostic_source, 'baseline')
  assert.match(renderReport(report), /基线归档发现异常位置/)
  assert.equal(f.calls.length, 0); assert.equal(report.execution.new_evaluation_model_calls, 0)
  assert.equal(fs.readFileSync(baseline, 'utf8'), raw)
})

test('diagnosed input failure cannot become a shareable PASS or a usable receipt', async t => {
  const f = setup(t)
  fs.writeFileSync(f.input, '{} invalid')
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  const result = await createExportService(f.options).export({ run_id: report.run_id, format: 'share' })
  assert.equal(report.status, 'REVIEW'); assert.equal(result.exported, false)
  assert.equal(result.share_summary, undefined); assert.equal(f.calls.length, 0)
})

test('new receipts bind the changes module and record local version without changing old JSON export', async t => {
  const f = await receiptFixture(t)
  const original = fs.readFileSync(f.receipt), receipt = JSON.parse(original)
  assert.equal(receipt.payload.scope.plugin.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  assert.match(receipt.payload.scope.plugin.files['lib/changes.js'], /^[a-f0-9]{64}$/)
  const result = await createExportService(f.options).export({ run_id: f.report.run_id, format: 'json' })
  assert.equal(result.exported, true); assert.deepEqual(fs.readFileSync(result.path), original)
})

function card(value, metadata = {}) {
  let component, state = 0
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useState: initial => [state++ === 0 ? value : initial, () => {}],
    useRef: () => ({}), useCallback: fn => fn, useEffect() {},
  }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => factory(() => React).apply({ slots: {
      inject: (_name, fn) => [...fn()], register: (_slot, c) => { component = c },
    } }) } },
  })
  return JSON.stringify(component({ block: { meta: { veriscope: { run_id: 'fixture', session_id: 'session', ...metadata } } } }))
}

test('native card keeps REVIEW and one read-only button while showing a concrete policy change', () => {
  const rendered = card({ current_verdict: 'REVIEW', historical_verdict: 'PASS', changes: {
    state: 'COMPLETE', total: 1, truncated: false, items: [{ field: 'thresholds.faith', label: 'Faithfulness 阈值', before: .8, after: .9 }],
  } })
  assert.match(rendered, /绑定项变化/); assert.match(rendered, /Faithfulness 阈值：0.8 → 0.9/)
  assert.match(rendered, /"data-veriscope-status":"REVIEW"/)
  assert.equal((rendered.match(/"tag":"button"/g) ?? []).length, 1)
  assert.match(rendered, /不解释分数变化的因果/)
})

test('native card labels incomplete changes and original JSON location without rendering historical PASS as current', () => {
  const rendered = card(null, { historical_verdict: 'PASS', input_diagnostic: { line: 3, column: 2, source: 'baseline' } })
  assert.match(rendered, /原重放的归档诊断/); assert.match(rendered, /基线归档：第 3 行，第 2 列/)
  assert.match(rendered, /绑定项未核实/); assert.match(rendered, /"data-veriscope-status":"REVIEW"/)
})

test('native card bounds change rendering and makes truncation visible', () => {
  const rendered = card({ current_verdict: 'REVIEW', changes: { state: 'COMPLETE', total: 23, truncated: true,
    items: Array.from({ length: 23 }, (_, i) => ({ label: `字段${i}`, before: 1, after: 2 })),
  } })
  assert.match(rendered, /仅显示前 20 项/); assert.match(rendered, /字段19：1 → 2/)
  assert.doesNotMatch(rendered, /字段20：/)
})

test('native card discloses truncation even when other groups are unverified', () => {
  const rendered = card({ current_verdict: 'REVIEW', changes: { state: 'UNVERIFIED', total: 23, truncated: true,
    items: Array.from({ length: 23 }, (_, i) => ({ label: `字段${i}`, before: 1, after: 2 })),
  } })
  assert.match(rendered, /绑定项未核实/); assert.match(rendered, /已确认 23 项变化，仅显示前 20 项/)
  assert.doesNotMatch(rendered, /字段20：/)
})

async function refreshCard(policy) {
  let component, refresh
  const requests = []
  const React = { createElement: () => null, useState: initial => [initial, () => {}], useRef: () => ({}), useCallback: fn => (refresh = fn), useEffect() {} }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), {
    AbortController,
    fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: false } },
    window: { __ModuleLoader__: { load: ({ factory }) => factory(() => React).apply({ slots: {
      inject: (_name, fn) => [...fn()], register: (_slot, c) => { component = c },
    } }) } },
  })
  component({ block: { meta: { veriscope: { run_id: 'fixture', session_id: 'session', policy } } } })
  await refresh()
  return requests
}

test('native refresh carries the same explicit thresholds and baseline expectation', async () => {
  const policy = { faith: .9, ctx: .7, baseline_run_id: null }
  const requests = await refreshCard(policy)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0], { run_id: 'fixture', session_id: 'session', policy })
})

test('invalid native policy never falls back to a default-threshold status request', async () => {
  for (const policy of [null, [], { faith: 1.1 }, { faith: '0.9' }, { path: 'private' }, { baseline_run_id: '../x' }, { baseline_run_id: '01234567-0123-4123-8123-0123456789ab\n' }]) {
    assert.equal((await refreshCard(policy)).length, 0)
  }
})

test('real status bridge preserves query policy and rejects paths, invalid thresholds and unknown fields', async t => {
  const run = '01234567-0123-4123-8123-0123456789ab', calls = []
  let route
  registerStatusBridge({ get: () => ({ protocol: 'http:', register: value => { route = value; return () => {} } }) }, {
    status: async args => { calls.push(args); return { current_verdict: 'REVIEW', gate_passed: null } },
  }, new Map([['session', new Set([run])]]))
  const server = http.createServer((req, res) => route.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const call = policy => fetch(origin + '/veriscope/status', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'session', run_id: run, policy }) })
  assert.equal((await call({ faith: .9, ctx: .7, baseline_run_id: null })).status, 200)
  assert.deepEqual(calls, [{ faith: .9, ctx: .7, baseline_run_id: null, run_id: run }])
  for (const policy of [null, [], { faith: '0.9' }, { faith: -1 }, { ctx: 2 }, { result_path: 'private' }, { run_id: run }, { baseline_run_id: '../x' }]) assert.equal((await call(policy)).status, 400)
  assert.equal(calls.length, 1)
})
