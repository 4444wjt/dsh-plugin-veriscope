import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { temporary } from './helpers.js'
import { receiptFixture } from './fusion-helpers.js'
import { BUILTIN_ENGINE, validatePolicy, normalizeArchive, evaluateThresholds } from '../lib/builtin-rules.js'
import { createBuiltinService } from '../lib/builtin.js'
import { BUILTIN_FILES, writeBuiltinReceipt } from '../lib/builtin-receipt.js'
import { createStatusService, readRecord } from '../lib/status.js'
import { createListService } from '../lib/catalog.js'
import { createExportService } from '../lib/export.js'
import { createManagedService } from '../lib/managed.js'
import { createDoctorService } from '../lib/doctor.js'
import { createToolCatalog } from '../lib/tools.js'
import { builtinReportSchema, statusSchema } from '../lib/schema.js'
import { validToolArguments } from '../lib/mcp.js'
import { previewRetention } from '../scripts/prune.mjs'
import { digest } from '../lib/receipt.js'
import vm from 'node:vm'

const repo = fileURLToPath(new URL('../', import.meta.url))
const makePolicy = (rules = [{ metric: 'quality', unit: 'ratio', operator: 'gte', threshold: .8, range: { min: 0, max: 1 } }]) => ({ schema_version: 'GatePolicyV1', aggregation: 'mean', population: 'all_provided_rows', rules })
const makeArchive = (scores = [.9, .9]) => ({ schema_version: 'GateArchiveV1', source: { producer: 'constructed-test', version: null }, rows: scores.map((quality, index) => ({ id: `row-${index + 1}`, scores: { quality } })) })
function judge(scores, rules) { const policy = validatePolicy(makePolicy(rules)); return evaluateThresholds(normalizeArchive(makeArchive(scores), policy), policy) }
function fixture(t, { archive = makeArchive(), policy = makePolicy(), format, pluginRoot } = {}) {
  const root = temporary(t), archive_path = path.join(root, '评分 中文 & $().json'), policy_path = path.join(root, '策略.json')
  fs.writeFileSync(archive_path, JSON.stringify(archive)); fs.writeFileSync(policy_path, JSON.stringify(policy))
  const options = { env: { VERISCOPE_STATE_DIR: path.join(root, 'state') }, ...(pluginRoot ? { pluginRoot } : {}) }
  const args = { archive_path, policy_path, ...(format ? { format } : {}) }
  return { root, args, options, service: createBuiltinService(options), statuses: createStatusService(options) }
}
const execution = { agent: { session: { id: 'actual-host-session' } } }

for (const [scores, expected, mean] of [[[.9, .9], 'PASS', .9], [[.7, .7], 'FAIL', .7], [[.8], 'PASS', .8], [[0, 1], 'FAIL', .5], [[], 'REVIEW', null]]) {
  test(`mean/gte ${JSON.stringify(scores)} has independent expected verdict ${expected}`, () => {
    const value = judge(scores); assert.equal(value.status, expected); assert.equal(value.metrics[0].mean, mean)
    assert.equal(value.gate_passed, expected === 'REVIEW' ? null : expected === 'PASS')
  })
}
for (const [score, expected] of [[120, 'PASS'], [150, 'PASS'], [151, 'FAIL'], [-1, 'PASS']]) test(`lte accepts general finite units and inclusive boundary ${score}`, () => {
  const result = judge([score], [{ metric: 'quality', unit: 'ms', operator: 'lte', threshold: 150 }])
  assert.equal(result.status, expected)
})
for (const invalid of [null, '0.9', true, {}, [], -1, 1.1]) test(`missing or malformed metric ${JSON.stringify(invalid)} never shrinks the denominator`, () => {
  const result = judge([1, invalid]); assert.equal(result.status, 'REVIEW'); assert.equal(result.metrics[0].mean, null)
  assert.equal(result.metrics[0].total_count, 2); assert.equal(result.metrics[0].valid_count, 1)
  assert.equal(result.metrics[0].missing_count + result.metrics[0].invalid_count, 1)
})
test('missing column is retained, not guessed or mapped from a similarly named metric', () => {
  const policy = validatePolicy(makePolicy()), archive = makeArchive()
  archive.rows[1].scores = { pos_quality: .9 }
  const result = evaluateThresholds(normalizeArchive(archive, policy), policy)
  assert.equal(result.status, 'REVIEW'); assert.equal(result.metrics[0].missing_count, 1)
})
test('known complete failure takes precedence over another incomplete metric', () => {
  const policy = validatePolicy(makePolicy([{ metric: 'quality', unit: 'ratio', operator: 'gte', threshold: .8 }, { metric: 'missing', unit: 'ms', operator: 'lte', threshold: 10 }]))
  const result = evaluateThresholds(normalizeArchive(makeArchive([.7]), policy), policy)
  assert.equal(result.status, 'FAIL'); assert.deepEqual(result.metrics.map(m => m.status), ['FAIL', 'REVIEW'])
})
test('incomplete metric has no known failure based on only its available low values', () => {
  assert.equal(judge([.1, null]).status, 'REVIEW')
})
test('finite extreme inputs do not become an infinite successful mean', () => {
  const result = judge([Number.MAX_VALUE, -Number.MAX_VALUE], [{ metric: 'quality', unit: 'arbitrary', operator: 'gte', threshold: 0 }])
  assert.equal(result.metrics[0].mean, 0); assert.equal(result.status, 'PASS')
})

test('finite large equal inputs keep their mean after sum overflow', () => {
  const result = judge([Number.MAX_VALUE, Number.MAX_VALUE], [{ metric: 'quality', unit: 'arbitrary', operator: 'gte', threshold: Number.MAX_VALUE }])
  assert.equal(result.metrics[0].mean, Number.MAX_VALUE); assert.equal(result.status, 'PASS')
})

test('subnormal scores are not divided into zero before summation', () => {
  const rule = { metric: 'quality', unit: 'arbitrary', operator: 'gte', threshold: Number.MIN_VALUE }
  const result = judge([Number.MIN_VALUE, Number.MIN_VALUE], [rule])
  assert.equal(result.metrics[0].mean, Number.MIN_VALUE); assert.equal(result.status, 'PASS')
  assert.equal(judge([Number.MIN_VALUE, Number.MIN_VALUE], [{ ...rule, operator: 'lte', threshold: 0 }]).status, 'FAIL')
})
test('threshold comparison never rounds the result or invents a tolerance', () => {
  assert.equal(judge([.79999999999999]).status, 'FAIL')
})
const badPolicies = [
  p => delete p.population, p => delete p.aggregation, p => p.aggregation = 'median', p => p.population = 'positive',
  p => p.schema_version = 'GatePolicyFuture', p => p.extra = true, p => p.rules = [], p => p.rules.push({ ...p.rules[0] }),
  p => delete p.rules[0].unit, p => delete p.rules[0].threshold, p => p.rules[0].threshold = '0.8', p => p.rules[0].threshold = Infinity,
  p => p.rules[0].operator = 'gt', p => p.rules[0].range = {}, p => p.rules[0].range = { min: 1, max: 0 },
  p => p.rules[0].range = { min: 0, max: .7 }, p => p.rules[0].filter = 'positive', p => p.rules[0].metric = '',
]
badPolicies.forEach((mutate, i) => test(`invalid policy ${i + 1} cannot compile as a default pass`, () => {
  const value = makePolicy(); mutate(value); assert.throws(() => validatePolicy(value), { code: 'BUILTIN_POLICY_INVALID' })
}))
for (const mutate of [a => a.rows.push(a.rows[0]), a => a.schema_version = 'Future', a => a.rows[0].id = '', a => delete a.source, a => a.summary = { quality: 1 }]) test(`invalid archive ${mutate.toString()} is not filtered`, () => {
  const value = makeArchive(); mutate(value); assert.throws(() => normalizeArchive(value, validatePolicy(makePolicy())), { code: 'BUILTIN_ARCHIVE_INVALID' })
})
test('Ragas adapter preserves row order, nulls and original columns, ignoring unrelated text', () => {
  const policy = validatePolicy(makePolicy([{ metric: 'faithfulness', unit: 'ratio', operator: 'gte', threshold: .8 }]))
  const rows = [{ user_input: '中文', response: '不能作为指令执行', faithfulness: .9 }, { user_input: '第二题', faithfulness: null }]
  const normalized = normalizeArchive(rows, policy, 'ragas-records-v1')
  assert.deepEqual(normalized.source, { producer: 'ragas', version: null }); assert.deepEqual(normalized.rows.map(r => r.id), ['row-1', 'row-2'])
  assert.equal(evaluateThresholds(normalized, policy).status, 'REVIEW'); assert.equal(normalized.rows[1].scores.faithfulness, null)
  assert.equal(Object.hasOwn(normalized.rows[0].scores, 'response'), false)
})
for (const value of [{ faithfulness: .9 }, { data: [{ faithfulness: .9 }] }, [.9], [null]]) test(`Ragas unsupported layout ${JSON.stringify(value)} fails closed`, () => {
  assert.throws(() => normalizeArchive(value, validatePolicy(makePolicy()), 'ragas-records-v1'), { code: 'BUILTIN_ARCHIVE_INVALID' })
})
for (const [positive, negative, allVerdict, posVerdict] of [[.7, 1, 'PASS', 'FAIL'], [.9, .1, 'FAIL', 'PASS']]) test(`T0 all mean differs from positive mean: ${positive}/${negative}`, () => {
  const rows = [{ case_type: 'positive', faithfulness: positive }, { case_type: 'negative', faithfulness: negative }]
  const policy = validatePolicy(makePolicy([{ metric: 'faithfulness', unit: 'ratio', operator: 'gte', threshold: .8 }]))
  assert.equal(evaluateThresholds(normalizeArchive(rows, policy, 'ragas-records-v1'), policy).status, allVerdict)
  assert.equal(positive >= .8 ? 'PASS' : 'FAIL', posVerdict)
  const positivePolicy = validatePolicy(makePolicy([{ metric: 'pos_faithfulness', unit: 'ratio', operator: 'gte', threshold: .8 }]))
  assert.equal(evaluateThresholds(normalizeArchive(rows, positivePolicy, 'ragas-records-v1'), positivePolicy).status, 'REVIEW')
})

for (const [scores, expected] of [[[.9], 'PASS'], [[.7], 'FAIL'], [[null], 'REVIEW']]) test(`executed ${expected} creates ReceiptV2, reusable status and no fake Python fields`, async t => {
  const f = fixture(t, { archive: makeArchive(scores) }), report = await f.service.check(f.args)
  assert.equal(report.status, expected); assert.equal(report.execution.new_evaluation_model_calls, 0); assert.equal(report.execution.session_id, null)
  assert.equal(report.recording.receipt_available, true); assert.equal(validToolArguments(report, builtinReportSchema), true)
  assert.equal(Object.hasOwn(report.execution, 'command'), false); assert.equal(Object.hasOwn(report, 'exit_code'), false)
  const record = readRecord({ run_id: report.run_id }, f.options)
  assert.equal(record.receipt.schema_version, 'ReceiptV2'); assert.deepEqual({ ...record.receipt.payload.engine }, BUILTIN_ENGINE)
  assert.equal(Object.hasOwn(record.receipt.payload, 'session_id'), false)
  assert.deepEqual(Object.keys(record.receipt.payload.scope.environment).sort(), ['arch', 'executable', 'node', 'platform'])
  const before = fs.readFileSync(path.join(record.run.directory, 'receipt.json'))
  const status = await f.statuses.status({ run_id: report.run_id })
  assert.equal(status.current_verdict, expected); assert.equal(status.integrity, 'VALID'); assert.equal(status.freshness, 'FRESH')
  assert.equal(validToolArguments(status, statusSchema), true); assert.equal(Object.hasOwn(status.details.environment, 'pandas'), false)
  assert.deepEqual(fs.readFileSync(path.join(record.run.directory, 'receipt.json')), before)
})
for (const key of ['archive_path', 'policy_path']) test(`changed ${key} bytes with preserved mtime invalidates current PASS`, async t => {
  const f = fixture(t), report = await f.service.check(f.args), file = f.args[key], stat = fs.statSync(file)
  fs.appendFileSync(file, ' '); fs.utimesSync(file, stat.atime, stat.mtime)
  const status = await f.statuses.status({ run_id: report.run_id })
  assert.equal(status.historical_verdict, 'PASS'); assert.equal(status.current_verdict, 'REVIEW'); assert.equal(status.freshness, 'STALE')
  assert.ok(status.reason_codes.includes(key === 'archive_path' ? 'INPUT_CHANGED' : 'POLICY_CHANGED'))
})
for (const file of ['receipt.json', 'report.json', 'input.json', 'policy.json', 'normalized.json']) test(`tampered ${file} is never reusable`, async t => {
  const f = fixture(t), report = await f.service.check(f.args)
  fs.appendFileSync(path.join(report.recording.artifacts_path, file), 'x')
  const status = await f.statuses.status({ run_id: report.run_id })
  assert.equal(status.current_verdict, 'REVIEW'); assert.equal(status.gate_passed, null)
})
test('adapter bytes change invalidates ReceiptV2, including unchanged mtime', async t => {
  const pluginRoot = temporary(t)
  for (const file of BUILTIN_FILES) { fs.mkdirSync(path.dirname(path.join(pluginRoot, file)), { recursive: true }); fs.copyFileSync(path.join(repo, file), path.join(pluginRoot, file)) }
  const f = fixture(t, { pluginRoot }), report = await f.service.check(f.args), file = path.join(pluginRoot, 'lib/builtin-rules.js'), stat = fs.statSync(file)
  fs.appendFileSync(file, ' '); fs.utimesSync(file, stat.atime, stat.mtime)
  const status = await f.statuses.status({ run_id: report.run_id })
  assert.equal(status.current_verdict, 'REVIEW'); assert.ok(status.reason_codes.includes('PLUGIN_CHANGED'))
})
test('Node environment mismatch is stale and needs no Python', async t => {
  const f = fixture(t), report = await f.service.check(f.args), file = path.join(report.recording.artifacts_path, 'receipt.json')
  const r = JSON.parse(fs.readFileSync(file)); r.payload.scope.environment.node = 'v0.0.0'
  r.payload.scope_digest = digest(r.payload.scope); r.integrity_sha256 = digest(r.payload); fs.writeFileSync(file, JSON.stringify(r))
  const status = await f.statuses.status({ run_id: report.run_id }); assert.equal(status.current_verdict, 'REVIEW'); assert.ok(status.reason_codes.includes('ENVIRONMENT_CHANGED'))
})
test('B2 status rejects original gate policy parameters instead of silently ignoring them', async t => {
  const f = fixture(t), report = await f.service.check(f.args)
  const status = await f.statuses.status({ run_id: report.run_id, faith: .1 })
  assert.equal(status.current_verdict, 'REVIEW'); assert.ok(status.reason_codes.includes('BUILTIN_POLICY_ARGUMENT'))
})
for (const invalid of ['', 'relative', null]) test(`invalid explicit state ${String(invalid)} creates no receipt`, async t => {
  const f = fixture(t), report = await createBuiltinService({ env: { VERISCOPE_STATE_DIR: invalid } }).check(f.args)
  assert.equal(report.status, 'REVIEW'); assert.equal(report.execution.executed, false); assert.equal(report.recording.receipt_available, false)
})
test('missing explicit state never uses DSH package default', async t => {
  const f = fixture(t), report = await createBuiltinService({ env: {} }).check(f.args)
  assert.equal(report.execution.executed, false); assert.ok(report.execution.errors.some(e => e.code === 'INVALID_STATE_DIR'))
})
for (const mutate of [a => a.archive_path = 'relative.json', a => a.policy_path = '', a => a.format = 'auto', a => a.session_id = 'forged']) test(`invalid check args ${mutate.toString()} do not execute`, async t => {
  const f = fixture(t); mutate(f.args); const report = await f.service.check(f.args)
  assert.equal(report.status, 'REVIEW'); assert.equal(report.execution.executed, false)
})
for (const body of ['{bad', '{"schema_version":"GateArchiveV1","schema_version":"GateArchiveV1"}', '[1e400]']) test('parse failure never creates a receipt or drops malformed tokens', async t => {
  const f = fixture(t); fs.writeFileSync(f.args.archive_path, body)
  const report = await f.service.check(f.args)
  assert.equal(report.status, 'REVIEW'); assert.equal(report.recording.receipt_available, false); assert.equal(report.execution.executed, false)
  assert.ok(report.execution.errors.some(e => e.code === 'INVALID_JSON'))
})
for (const score of [.9, .7]) test(`receipt publication failure preserves a known FAIL and blocks a PASS (${score})`, async t => {
  const f = fixture(t, { archive: makeArchive([score]) })
  const spy = mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('simulated write failure'), { code: 'EACCES' }) })
  let report
  try { report = await f.service.check(f.args) } finally { spy.mock.restore() }
  assert.equal(report.status, score < .8 ? 'FAIL' : 'REVIEW'); assert.equal(report.judgement, score < .8 ? 'FAIL' : 'PASS')
  assert.equal(report.recording.receipt_available, false); assert.equal(report.recording.eligible_at_recording, false)
  assert.ok(fs.existsSync(path.join(report.recording.artifacts_path, 'recording-error.json')))
  const status = await f.statuses.status({ run_id: report.run_id }); assert.equal(status.current_verdict, 'REVIEW')
})
test('input mutation during artifact writing suppresses receipt, even with an evaluated PASS', async t => {
  const f = fixture(t), original = fs.writeFileSync.bind(fs)
  const spy = mock.method(fs, 'writeFileSync', (file, ...args) => {
    const result = original(file, ...args)
    if (path.basename(String(file)) === 'normalized.json') original(f.args.archive_path, JSON.stringify(makeArchive([.1])))
    return result
  })
  let report; try { report = await f.service.check(f.args) } finally { spy.mock.restore() }
  assert.equal(report.judgement, 'PASS'); assert.equal(report.status, 'REVIEW'); assert.equal(report.recording.receipt_available, false)
  assert.ok(report.execution.errors.some(e => e.code === 'SCOPE_CHANGED'))
})
test('cancelled check creates no receipt', async t => {
  const f = fixture(t), c = new AbortController(); c.abort()
  const report = await f.service.check(f.args, { signal: c.signal }); assert.equal(report.status, 'REVIEW'); assert.equal(report.execution.executed, false)
})
test('writer refuses a diagnostic that did not execute the judge', t => {
  assert.throws(() => writeBuiltinReceipt(temporary(t), { execution: { executed: false } }, {}), { code: 'NO_EXECUTED_CHECK' })
})
test('B2 receipt cannot bind or complete a managed task', async t => {
  const f = fixture(t), report = await f.service.check(f.args), managed = createManagedService(f.options)
  const denied = await managed.bind({ task_id: 'task', run_id: report.run_id }, execution)
  assert.equal(denied.accepted, false); assert.equal(denied.reason_code, 'BUILTIN_MANAGED_UNSUPPORTED')
  const complete = await managed.complete({ task_id: 'task', run_id: report.run_id }, execution)
  assert.equal(complete.accepted, false); assert.equal(complete.reason_code, 'BUILTIN_MANAGED_UNSUPPORTED')
  assert.equal(complete.status.engine.id, BUILTIN_ENGINE.id)
  managed.dispose()
})
test('mixed ReceiptV1/V2 list, exact JSON export, generic Markdown and dry-run inventory work', async t => {
  const old = await receiptFixture(t), f = fixture(t)
  const report = await f.service.check(f.args), source = path.join(old.report.execution.artifacts_path)
  fs.cpSync(source, path.join(f.options.env.VERISCOPE_STATE_DIR, 'runs', old.report.run_id), { recursive: true })
  const list = await createListService(f.options).list({})
  assert.equal(list.items.length, 2); assert.ok(list.items.some(i => i.engine?.id === BUILTIN_ENGINE.id && i.current_verdict === 'PASS'))
  const exporter = createExportService(f.options)
  const exported = await exporter.export({ run_id: report.run_id, format: 'json' })
  assert.equal(exported.exported, true); assert.deepEqual(fs.readFileSync(exported.path), fs.readFileSync(path.join(report.recording.artifacts_path, 'receipt.json')))
  const md = await exporter.export({ run_id: report.run_id, format: 'md' })
  assert.equal(md.exported, true); assert.match(fs.readFileSync(md.path, 'utf8'), /builtin-threshold-v1/); assert.doesNotMatch(fs.readFileSync(md.path, 'utf8'), /正向 Faithfulness/)
  const count = fs.readdirSync(path.dirname(md.path)).length, share = await exporter.export({ run_id: report.run_id, format: 'share' })
  assert.equal(share.exported, false); assert.deepEqual(share.reason_codes, ['BUILTIN_SHARE_UNSUPPORTED']); assert.equal(fs.readdirSync(path.dirname(md.path)).length, count)
  const preview = previewRetention(f.options.env)
  assert.ok(preview.runs.some(r => r.engine?.id === BUILTIN_ENGINE.id)); assert.equal(preview.deletion_supported, false)
  assert.ok(preview.exports.some(e => e.run_ids.includes(report.run_id)))
})
test('builtin doctor is ready without VeriScope, Python or pandas and leaves no probe', async t => {
  const f = fixture(t), value = await createDoctorService(f.options).doctor({ engine: 'builtin' })
  assert.equal(value.ready, true); assert.equal(value.engine.id, BUILTIN_ENGINE.id); assert.equal(Object.hasOwn(value.environment, 'python'), false)
  assert.equal(fs.readdirSync(f.options.env.VERISCOPE_STATE_DIR).some(name => name.startsWith('.doctor-')), false)
})
test('shared tool catalog exposes the Node-only judge with true host session identity', async t => {
  const f = fixture(t), tools = createToolCatalog(f.options), tool = tools.tools.find(t => t.name === 'veriscope_gate_check')
  const value = await tool.call(f.args, { sessionId: 'real-session' })
  assert.equal(value.status, 'PASS'); assert.equal(value.execution.session_id, 'real-session'); assert.equal(tool.presentation, 'utility')
  tools.dispose()
})
for (const [scores, code, status] of [[[.9], 0, 'PASS'], [[.7], 1, 'FAIL'], [[null], 2, 'REVIEW']]) test(`CLI runs without Python and exits ${code}`, t => {
  const f = fixture(t, { archive: makeArchive(scores) })
  const child = spawnSync(process.execPath, ['scripts/check.mjs', '--archive', path.relative(repo, f.args.archive_path), '--policy', path.relative(repo, f.args.policy_path), '--json'], {
    cwd: repo, env: { SystemRoot: process.env.SystemRoot, PATH: '', ...f.options.env }, windowsHide: true, encoding: 'utf8', timeout: 15000,
  })
  assert.equal(child.status, code, child.stderr); const value = JSON.parse(child.stdout)
  assert.equal(value.status, status); assert.equal(value.recording.receipt_available, true); assert.equal(value.execution.session_id, null)
})
test('CLI rejects unknown options and never invokes a shell', t => {
  const f = fixture(t)
  const child = spawnSync(process.execPath, ['scripts/check.mjs', '--execute', 'echo unsafe', '--json'], { cwd: repo, env: f.options.env, windowsHide: true, encoding: 'utf8' })
  assert.equal(child.status, 2); assert.equal(JSON.parse(child.stdout).schema_version, 'BuiltinCliErrorV1')
  assert.equal(fs.existsSync(f.options.env.VERISCOPE_STATE_DIR), false)
})

for (const [score, expected] of [[.9, 'PASS'], [.7, 'FAIL'], [null, 'REVIEW']]) test(`Ragas records real service boundary returns ${expected}`, async t => {
  const f = fixture(t, { archive: [{ user_input: '构造问题', response: '构造回答', quality: score }], format: 'ragas-records-v1' })
  const report = await f.service.check(f.args)
  assert.equal(report.status, expected); assert.equal(report.recording.receipt_available, true)
  assert.equal(report.source.version, null); assert.equal(report.source.verification, 'declared_only')
  assert.equal((await f.statuses.status({ run_id: report.run_id })).current_verdict, expected)
})
test('public JSON Schemas accept shipped examples and reject a wrong version or unknown policy field', () => {
  const archiveSchema = JSON.parse(fs.readFileSync(path.join(repo, 'schemas/gate-archive-v1.schema.json')))
  const policySchema = JSON.parse(fs.readFileSync(path.join(repo, 'schemas/gate-policy-v1.schema.json')))
  const archive = JSON.parse(fs.readFileSync(path.join(repo, 'examples/builtin/archive.json')))
  const policy = JSON.parse(fs.readFileSync(path.join(repo, 'examples/builtin/policy.json')))
  assert.equal(validToolArguments(archive, archiveSchema), true); assert.equal(validToolArguments(policy, policySchema), true)
  assert.equal(validToolArguments({ ...archive, schema_version: 'Unknown' }, archiveSchema), false)
  assert.equal(validToolArguments({ ...policy, filter: 'positive' }, policySchema), false)
})
test('B2 status uses text fallback instead of legacy metrics or a card refresh request', async () => {
  let component, callback
  const calls = []
  const React = { createElement: (tag, props, ...children) => ({ tag, props, children }), useState: initial => [initial, () => {}],
    useRef: () => ({}), useCallback: fn => { callback = fn; return fn }, useEffect() {} }
  vm.runInNewContext(fs.readFileSync(path.join(repo, 'client.js'), 'utf8'), { AbortController, fetch: (...args) => { calls.push(args); throw new Error('no B2 card request allowed') },
    window: { __ModuleLoader__: { load: ({ factory }) => factory(() => React).apply({ slots: {
      inject: (_name, fn) => [...fn()], register: (_slot, value) => { component = value },
    } }) } } })
  const value = component({ block: { meta: { veriscope: { engine_id: 'builtin-threshold-v1', builtin_text: '独立阈值门禁：通过；不用于任务完成。' } } } })
  assert.equal(value.tag, 'pre'); assert.equal(value.props['data-veriscope-mode'], 'builtin-text')
  assert.doesNotMatch(JSON.stringify(value), /正向|Python|button/)
  await callback(); assert.equal(calls.length, 0)
})
test('mixed export rejects B2 share atomically rather than sharing the legacy portion', async t => {
  const old = await receiptFixture(t), f = fixture(t), report = await f.service.check(f.args)
  fs.cpSync(old.report.execution.artifacts_path, path.join(f.options.env.VERISCOPE_STATE_DIR, 'runs', old.report.run_id), { recursive: true })
  const value = await createExportService(f.options).export({ run_ids: [old.report.run_id, report.run_id], format: 'share' })
  assert.equal(value.exported, false); assert.deepEqual(value.reason_codes, ['BUILTIN_SHARE_UNSUPPORTED'])
  assert.equal(fs.existsSync(path.join(f.options.env.VERISCOPE_STATE_DIR, 'exports')), false)
})
