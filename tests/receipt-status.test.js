import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createReplayService } from '../lib/replay.js'
import { createStatusService } from '../lib/status.js'
import { RECEIPT_FILES, digest, storePaths } from '../lib/receipt.js'
import { setup, temporary } from './helpers.js'
import { receiptFixture } from './fusion-helpers.js'
for (const kind of ['pass', 'fail']) test(`replay alone creates ReceiptV1; unchanged ${kind} is verified and query is read-only`, async t => {
  const f = await receiptFixture(t, kind)
  const bytes = fs.readFileSync(f.receipt), before = fs.readdirSync(f.report.execution.artifacts_path)
  const result = await f.status.status(f.request)
  assert.equal(result.current_verdict, kind.toUpperCase()); assert.equal(result.gate_passed, kind === 'pass')
  assert.equal(result.integrity, 'VALID'); assert.equal(result.freshness, 'FRESH')
  assert.deepEqual(fs.readFileSync(f.receipt), bytes); assert.deepEqual(fs.readdirSync(f.report.execution.artifacts_path), before)
})
test('same path changed bytes with preserved mtime makes historical PASS current REVIEW', async t => {
  const f = await receiptFixture(t), stat = fs.statSync(f.input)
  const original = fs.readFileSync(f.input, 'utf8')
  fs.writeFileSync(f.input, original.replace('0.8607', '0.9607')); fs.utimesSync(f.input, stat.atime, stat.mtime)
  const result = await f.status.status(f.request)
  assert.equal(result.historical_verdict, 'PASS'); assert.equal(result.current_verdict, 'REVIEW'); assert.equal(result.gate_passed, null)
  assert.ok(result.reason_codes.includes('INPUT_CHANGED'))
})
for (const value of [0, 1, 0.9]) test(`explicit policy change ${value} cannot recompute old scores into PASS`, async t => {
  const f = await receiptFixture(t), result = await f.status.status({ ...f.request, faith: value })
  assert.equal(result.current_verdict, 'REVIEW'); assert.ok(result.reason_codes.includes('POLICY_CHANGED'))
})
for (const target of ['receipt.json', 'report.json', 'stdout.txt', 'stderr.txt']) test(`corrupt ${target} is rejected`, async t => {
  const f = await receiptFixture(t)
  fs.appendFileSync(path.join(f.report.execution.artifacts_path, target), 'corruption')
  const result = await f.status.status(f.request)
  assert.equal(result.current_verdict, 'REVIEW'); assert.equal(result.gate_passed, null)
})
for (const mode of ['missing', 'partial', 'unknown_schema', 'edited_payload']) test(`receipt ${mode} cannot be consumed`, async t => {
  const f = await receiptFixture(t)
  if (mode === 'missing') fs.unlinkSync(f.receipt)
  else if (mode === 'partial') fs.writeFileSync(f.receipt, '{"schema_version":')
  else { const r = JSON.parse(fs.readFileSync(f.receipt)); if (mode === 'unknown_schema') r.schema_version = 'future'; else r.payload.historical_verdict = 'FAIL'; fs.writeFileSync(f.receipt, JSON.stringify(r)) }
  assert.equal((await f.status.status(f.request)).current_verdict, 'REVIEW')
})
test('missing original cannot recover PASS from residual report', async t => {
  const f = await receiptFixture(t); fs.unlinkSync(f.input)
  assert.equal((await f.status.status(f.request)).current_verdict, 'REVIEW')
})
test('changed upstream contract script never remains reusable', async t => {
  const f = await receiptFixture(t); fs.appendFileSync(path.join(f.root, 'scripts/gate_replay.py'), 'changed')
  const result = await f.status.status(f.request)
  assert.equal(result.current_verdict, 'REVIEW'); assert.ok(result.reason_codes.includes('CONTRACT_MISMATCH'))
})
test('plugin bytes matter even if the package version is unchanged', async t => {
  const root = temporary(t)
  for (const rel of RECEIPT_FILES) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.copyFileSync(new URL('../' + rel, import.meta.url), path.join(root, rel)) }
  const f = await receiptFixture(t, 'pass', { pluginRoot: root })
  fs.appendFileSync(path.join(root, 'lib/parser.js'), '\n// byte change\n')
  const result = await f.status.status(f.request)
  assert.equal(result.current_verdict, 'REVIEW'); assert.ok(result.reason_codes.includes('PLUGIN_CHANGED'))
})
test('visible interpreter bytes changed with same reported version is REVIEW', async t => {
  const f = await receiptFixture(t); fs.appendFileSync(f.options.env.VERISCOPE_PYTHON, 'changed')
  const result = await f.status.status(f.request)
  assert.equal(result.current_verdict, 'REVIEW'); assert.ok(result.reason_codes.includes('ENVIRONMENT_CHANGED'))
})
test('pandas metadata or Node description changes cannot be ignored', async t => {
  const f = await receiptFixture(t), run = f.runner
  f.options.runner = async (...args) => { const r = await run(...args); if (args[1].includes('-c')) { const p = JSON.parse(r.stdout); p.pandas_metadata_sha256 = '1'.repeat(64); r.stdout = JSON.stringify(p) } return r }
  const result = await createStatusService(f.options).status(f.request)
  assert.equal(result.current_verdict, 'REVIEW'); assert.ok(result.reason_codes.includes('ENVIRONMENT_CHANGED'))
})
test('change during environment probe is detected as a race', async t => {
  const f = await receiptFixture(t), runner = f.runner
  f.options.runner = async (...args) => { const result = await runner(...args); fs.appendFileSync(f.input, ' '); return result }
  const result = await createStatusService(f.options).status(f.request)
  assert.equal(result.current_verdict, 'REVIEW'); assert.ok(result.reason_codes.includes('CHECK_RACE'))
})
test('no model-submitted report or path can mint or substitute a receipt', async t => {
  const f = await receiptFixture(t)
  for (const run_id of ['../escape', 'D:\\receipt.json', '', 'not-a-uuid']) assert.equal((await f.status.status({ run_id })).current_verdict, 'REVIEW')
  assert.ok((await f.status.status({ ...f.request, report: { status: 'PASS' } })).reason_codes.includes('INVALID_ARGUMENT'))
})
test('explicit empty/relative state roots do not fall back to default', async t => {
  const f = setup(t)
  for (const value of ['', 'relative']) assert.throws(() => storePaths({ env: { ...f.options.env, VERISCOPE_STATE_DIR: value } }), /绝对路径/)
  const other = path.join(f.root, '自选 状态根')
  assert.equal(storePaths({ env: { VERISCOPE_STATE_DIR: other } }).stateRoot, other)
  assert.equal(fs.existsSync(other), false)
})
test('run directory junction outside state root is rejected', async t => {
  const f = await receiptFixture(t), outside = temporary(t), run_id = '01234567-0123-4123-8123-0123456789ab'
  fs.symlinkSync(outside, path.join(f.options.artifactsDir, run_id), process.platform === 'win32' ? 'junction' : 'dir')
  const result = await f.status.status({ run_id })
  assert.equal(result.current_verdict, 'REVIEW'); assert.ok(result.reason_codes.includes('STATE_PATH_ESCAPE'))
})
test('baseline reference is verified and never accepts arbitrary path or circular reference', async t => {
  const f = await receiptFixture(t)
  const self = await f.status.status({ ...f.request, baseline_run_id: f.report.run_id })
  assert.equal(self.current_verdict, 'REVIEW')
  assert.equal((await f.status.status({ ...f.request, baseline_run_id: '../baseline' })).current_verdict, 'REVIEW')
  assert.equal((await f.status.status({ ...f.request, baseline_run_id: null })).current_verdict, 'PASS')
})
test('confirmed FAIL survives receipt write collision and later status stays REVIEW', async t => {
  const f = setup(t, { kind: 'fail' }), run = f.runner
  f.options.runner = async (...args) => { const result = await run(...args); if (!args[1].includes('-c')) { const dir = fs.readdirSync(f.options.artifactsDir)[0]; fs.writeFileSync(path.join(f.options.artifactsDir, dir, 'receipt.json'), 'collision') } return result }
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, 'FAIL'); assert.equal(report.gate_passed, false)
  assert.equal((await createStatusService(f.options).status({ run_id: report.run_id })).current_verdict, 'REVIEW')
})
test('cancelled check and malformed threshold cannot return PASS', async t => {
  const f = await receiptFixture(t)
  assert.equal((await f.status.status(f.request, { signal: AbortSignal.abort() })).current_verdict, 'REVIEW')
  for (const faith of [-1, 2, null, '0.8', NaN]) assert.equal((await f.status.status({ ...f.request, faith })).current_verdict, 'REVIEW')
})
