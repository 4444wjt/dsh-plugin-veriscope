import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { compareScopeChanges, renderChanges, CHANGE_GROUPS, CHANGE_LIMIT } from '../lib/changes.js'
import { RECEIPT_FILES, digest } from '../lib/receipt.js'
import { createReplayService } from '../lib/replay.js'
import { createStatusService, renderStatus } from '../lib/status.js'
import { setup } from './helpers.js'

const HASH = 'a'.repeat(64), OTHER = 'b'.repeat(64), SECRET = 'SECRET_USER_PATH_OR_BODY'
function scope() {
  const input = { path: `/${SECRET}/input.json`, real_path: `/${SECRET}/input.json`, sha256: HASH, bytes: 100 }
  return {
    input, baseline: { ...input, path: `/${SECRET}/baseline.json` }, thresholds: { faith: 0.8, ctx: 0.8 },
    upstream: { root: `/${SECRET}/upstream`, contract_sha256: HASH, files: { 'scripts/gate_replay.py': HASH } },
    plugin: { root: `/${SECRET}/plugin`, version: '0.3.0', files: Object.fromEntries(RECEIPT_FILES.map(key => [key, HASH])), coverage: [...RECEIPT_FILES] },
    environment: { node: 'v24.21.0', python: { ...input, version: '3.11.9' }, pandas: { version: '3.0.6', metadata_sha256: HASH } },
  }
}
function change(root, keys, value) {
  let target = root
  for (const key of keys.slice(0, -1)) target = target[key]
  target[keys.at(-1)] = value
}
async function stableFixture(t, kind = 'pass', review = false) {
  const f = setup(t, { kind }), python = path.join(f.root, 'python-stub.bin'), originalRunner = f.runner
  fs.writeFileSync(python, 'local protocol stub; no model or interpreter')
  f.options.env.VERISCOPE_PYTHON = python
  f.options.runner = async (...args) => {
    const value = await originalRunner(...args)
    if (args[1].includes('-c')) value.stdout = JSON.stringify({ version: '3.11.9', pandas: '3.0.6', executable: python, pandas_metadata_sha256: '0'.repeat(64) })
    else if (review) value.stderr = 'protocol fixture diagnostic'
    return value
  }
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, review ? 'REVIEW' : kind.toUpperCase())
  const receipt = path.join(report.execution.artifacts_path, 'receipt.json')
  assert.ok(fs.existsSync(receipt), JSON.stringify(report.execution.errors))
  return { ...f, report, receipt, request: { run_id: report.run_id } }
}

test('unchanged complete fixed scope has no changes and no raw paths', () => {
  const before = scope(), result = compareScopeChanges(before, structuredClone(before))
  assert.deepEqual(result, { state: 'COMPLETE', items: [], total: 0, truncated: false, limit: CHANGE_LIMIT, unverified_groups: [] })
  assert.ok(!JSON.stringify(result).includes(SECRET))
  assert.match(renderChanges(result).join('\n'), /所列固定字段未发现变化/)
})

test('every supported fixed leaf reports its own change', async t => {
  const cases = [
    ['input', 'path', '/changed'], ['input', 'real_path', '/changed'], ['input', 'sha256', OTHER], ['input', 'bytes', 101],
    ['baseline', 'path', '/changed'], ['baseline', 'real_path', '/changed'], ['baseline', 'sha256', OTHER], ['baseline', 'bytes', 101],
    ['thresholds', 'faith', 0.9], ['thresholds', 'ctx', 0.9], ['upstream', 'root', '/changed'], ['upstream', 'contract_sha256', OTHER],
    ['upstream', 'files', 'scripts/gate_replay.py', OTHER], ['plugin', 'root', '/changed'], ['plugin', 'version', '0.3.1'],
    ['plugin', 'files', RECEIPT_FILES[0], OTHER], ['environment', 'node', 'v24.22.0'],
    ['environment', 'python', 'path', '/changed'], ['environment', 'python', 'real_path', '/changed'], ['environment', 'python', 'sha256', OTHER],
    ['environment', 'python', 'bytes', 102], ['environment', 'python', 'version', '3.12.1'],
    ['environment', 'pandas', 'version', '3.0.7'], ['environment', 'pandas', 'metadata_sha256', OTHER],
  ]
  for (const row of cases) await t.test(row.slice(0, -1).join('.'), () => {
    const before = scope(), after = structuredClone(before), keys = row.slice(0, -1)
    change(after, keys, row.at(-1))
    const result = compareScopeChanges(before, after)
    assert.equal(result.state, 'COMPLETE'); assert.equal(result.total, 1)
    assert.equal(result.items[0].field, keys.join('.'))
    assert.ok(!JSON.stringify(result).includes(SECRET))
    assert.ok(result.items.every(item => ['string', 'number'].includes(typeof item.before) && ['string', 'number'].includes(typeof item.after)))
  })
})

test('baseline presence and fixed coverage order changes are explicit', () => {
  const before = scope(), after = structuredClone(before)
  after.baseline = null
  after.plugin.coverage.reverse()
  const result = compareScopeChanges(before, after)
  assert.equal(result.state, 'COMPLETE'); assert.deepEqual(result.items.map(item => item.field), ['baseline.present', 'plugin.coverage'])
  assert.equal(compareScopeChanges({ ...before, baseline: null }, { ...after, baseline: null }).items.some(item => item.field === 'baseline.present'), false)
})

test('multiple differences retain fixed order and show total when truncated', () => {
  const before = scope(), after = structuredClone(before)
  after.input.sha256 = OTHER; after.thresholds.faith = 0.9
  for (const key of RECEIPT_FILES) after.plugin.files[key] = OTHER
  const result = compareScopeChanges(before, after)
  assert.equal(result.total, RECEIPT_FILES.length + 2); assert.equal(result.items.length, CHANGE_LIMIT); assert.equal(result.truncated, true)
  assert.deepEqual(result.items.slice(0, 2).map(item => item.field), ['input.sha256', 'thresholds.faith'])
  assert.match(renderChanges(result).join('\n'), /仅显示前 20 项/)
})

test('unknown or absent fields never silently become a complete all-same explanation', () => {
  for (const mutation of [
    value => { value.input.extra = SECRET }, value => { delete value.input.sha256 },
    value => { value.environment.python.extra = SECRET }, value => { delete value.environment.pandas.metadata_sha256 },
    value => { value.upstream.files[SECRET] = HASH }, value => { value.plugin.coverage.push(SECRET) },
    value => { delete value.plugin.files[RECEIPT_FILES[0]] }, value => { value.new_binding = SECRET },
    value => { delete value.thresholds }, value => { delete value.baseline },
  ]) {
    const before = scope(), after = structuredClone(before); mutation(after)
    const result = compareScopeChanges(before, after)
    assert.equal(result.state, 'UNVERIFIED'); assert.ok(result.unverified_groups.length > 0)
    assert.ok(!JSON.stringify(result).includes(SECRET)); assert.match(renderChanges(result).join('\n'), /不能据此声称全部未变/)
  }
})

test('unknown fields on both sides and invalid typed values remain unverified', () => {
  const before = scope(); before.input.new_binding = SECRET
  assert.equal(compareScopeChanges(before, structuredClone(before)).state, 'UNVERIFIED')
  const incomplete = scope(); delete incomplete.plugin.files[RECEIPT_FILES[0]]
  assert.equal(compareScopeChanges(incomplete, structuredClone(incomplete)).state, 'UNVERIFIED')
  for (const [keys, value] of [
    [['environment', 'node'], `1.2.3-${SECRET}`], [['plugin', 'version'], SECRET],
    [['input', 'sha256'], SECRET], [['input', 'bytes'], Infinity], [['thresholds', 'faith'], NaN],
    [['thresholds', 'ctx'], 2], [['environment', 'pandas', 'version'], null],
  ]) {
    const original = scope(), after = structuredClone(original); change(after, keys, value)
    const result = compareScopeChanges(original, after)
    assert.equal(result.state, 'UNVERIFIED'); assert.ok(!JSON.stringify(result).includes(SECRET))
  }
})

test('strict versions and hashes reject every terminal JavaScript line break', () => {
  for (const newline of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    for (const keys of [['plugin', 'version'], ['environment', 'node'], ['environment', 'python', 'version'], ['environment', 'pandas', 'version']]) {
      const before = scope(), after = structuredClone(before)
      change(after, keys, '1.2.3' + newline)
      const result = compareScopeChanges(before, after)
      assert.equal(result.state, 'UNVERIFIED'); assert.equal(result.items.length, 0)
      assert.ok(!JSON.stringify(result).includes('1.2.3'))
    }
    const before = scope(), after = structuredClone(before)
    after.input.sha256 = HASH + newline
    const result = compareScopeChanges(before, after)
    assert.equal(result.state, 'UNVERIFIED'); assert.equal(result.items.length, 0)
  }
})

for (const kind of ['pass', 'fail', 'review']) test(`status adds complete changes without altering ${kind} verdict or extra probes`, async t => {
  const f = await stableFixture(t, kind === 'fail' ? 'fail' : 'pass', kind === 'review'), original = fs.readFileSync(f.receipt), count = f.calls.length
  const result = await createStatusService(f.options).status(f.request)
  assert.equal(result.current_verdict, kind.toUpperCase()); assert.equal(result.historical_verdict, kind.toUpperCase())
  assert.equal(result.gate_passed, kind === 'pass' ? true : kind === 'fail' ? false : null)
  assert.deepEqual(result.reason_codes, [kind === 'review' ? 'CORE_REVIEW' : 'BINDINGS_UNCHANGED'])
  assert.equal(result.changes.state, 'COMPLETE'); assert.equal(result.changes.total, 0)
  assert.equal(f.calls.length - count, 1); assert.ok(f.calls.at(-1).args.includes('-c'))
  assert.deepEqual(fs.readFileSync(f.receipt), original)
})

test('same mtime changed bytes and policy changes appear together without new replay', async t => {
  const f = await stableFixture(t, 'fail'), stat = fs.statSync(f.input), source = fs.readFileSync(f.input, 'utf8'), count = f.calls.length
  fs.writeFileSync(f.input, source.replace('0.7375', '0.8375')); fs.utimesSync(f.input, stat.atime, stat.mtime)
  const result = await createStatusService(f.options).status({ ...f.request, faith: 0.9, ctx: 0.85 })
  assert.equal(result.historical_verdict, 'FAIL'); assert.equal(result.current_verdict, 'REVIEW'); assert.equal(result.gate_passed, null)
  assert.deepEqual(result.reason_codes, ['INPUT_CHANGED', 'POLICY_CHANGED'])
  assert.equal(result.changes.state, 'COMPLETE'); assert.deepEqual(result.changes.items.map(item => item.field), ['input.sha256', 'thresholds.faith', 'thresholds.ctx'])
  assert.equal(f.calls.length - count, 1)
})

test('contract mismatch preserves existing REVIEW and first-failure guard, all changes unverified', async t => {
  const f = await stableFixture(t, 'fail'), count = f.calls.length
  fs.appendFileSync(path.join(f.root, 'scripts/gate_replay.py'), 'changed')
  const result = await createStatusService(f.options).status(f.request)
  assert.equal(result.historical_verdict, 'FAIL'); assert.equal(result.current_verdict, 'REVIEW')
  assert.deepEqual(result.reason_codes, ['CONTRACT_MISMATCH']); assert.equal(f.calls.length, count)
  assert.deepEqual(result.changes.unverified_groups, [...CHANGE_GROUPS]); assert.deepEqual(result.changes.items, [])
  assert.match(renderStatus(result), /不能据此声称全部未变/)
})

test('missing source or corrupted record does not leave partial changes or leak paths in the annotation', async t => {
  for (const target of ['input', 'receipt']) {
    const f = await stableFixture(t)
    if (target === 'input') fs.unlinkSync(f.input)
    else fs.appendFileSync(f.receipt, SECRET)
    const result = await createStatusService(f.options).status(f.request)
    assert.equal(result.current_verdict, 'REVIEW'); assert.equal(result.changes.state, 'UNVERIFIED')
    assert.deepEqual(result.changes.items, []); assert.deepEqual(result.changes.unverified_groups, [...CHANGE_GROUPS])
    assert.ok(!JSON.stringify(result.changes).includes(f.root)); assert.ok(!JSON.stringify(result.changes).includes(SECRET))
  }
})

test('new unsupported scope binding does not alter legacy verdict and is visibly unverified', async t => {
  const f = await stableFixture(t), receipt = JSON.parse(fs.readFileSync(f.receipt))
  receipt.payload.scope.new_binding = SECRET
  receipt.payload.scope_digest = digest(receipt.payload.scope); receipt.integrity_sha256 = digest(receipt.payload)
  fs.writeFileSync(f.receipt, JSON.stringify(receipt))
  const result = await createStatusService(f.options).status(f.request)
  assert.equal(result.current_verdict, 'PASS'); assert.deepEqual(result.reason_codes, ['BINDINGS_UNCHANGED'])
  assert.equal(result.changes.state, 'UNVERIFIED'); assert.ok(!JSON.stringify(result.changes).includes(SECRET))
  assert.match(renderStatus(result), /变化说明未核实/)
})
