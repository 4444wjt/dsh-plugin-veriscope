import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { receiptFixture } from './fusion-helpers.js'
import { createExportService, renderExport } from '../lib/export.js'
import { createReplayService } from '../lib/replay.js'
import { createManagedService } from '../lib/managed.js'
import { digest } from '../lib/receipt.js'
import { sha256 } from '../lib/source.js'
import { ReviewError } from '../lib/errors.js'

const currentPass = { integrity: 'VALID', freshness: 'FRESH', current_verdict: 'PASS', gate_passed: true, reason_codes: ['BINDINGS_UNCHANGED'] }
const withStatus = (f, status = currentPass) => ({ ...f.options, statusService: { async status() { return status } } })
const shareArgs = f => ({ run_id: f.report.run_id, format: 'share' })
const fileText = value => fs.readFileSync(value.path, 'utf8')
function updateRecord(f, mutate) {
  const receipt = JSON.parse(fs.readFileSync(f.receipt, 'utf8'))
  const reportFile = path.join(path.dirname(f.receipt), 'report.json')
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'))
  mutate(receipt, report)
  const bytes = Buffer.from(JSON.stringify(report) + '\n')
  fs.writeFileSync(reportFile, bytes)
  receipt.payload.outputs['report.json'] = { sha256: sha256(bytes), bytes: bytes.length }
  receipt.payload.scope_digest = digest(receipt.payload.scope)
  receipt.integrity_sha256 = digest(receipt.payload)
  fs.writeFileSync(f.receipt, JSON.stringify(receipt) + '\n')
}

test('share exports a local Markdown summary without receipt metadata in its projection', async t => {
  const f = await receiptFixture(t), original = fs.readFileSync(f.receipt)
  const receipt = JSON.parse(original)
  const value = await createExportService(f.options).export(shareArgs(f))
  assert.equal(value.exported, true); assert.equal(path.extname(value.path), '.md')
  assert.equal(value.format, 'share'); assert.equal(value.sha256, null)
  assert.deepEqual(value.run_ids, []); assert.deepEqual(value.current, [])
  assert.equal(value.share_summary.is_receipt, false); assert.equal(value.share_summary.can_authorize_completion, false)
  assert.equal(value.share_summary.records[0].record, '记录1')
  const text = fileText(value), projection = JSON.stringify(value.share_summary)
  for (const forbidden of [f.input, f.report.run_id, receipt.payload.created_at_utc, receipt.integrity_sha256, receipt.payload.scope_digest]) {
    assert.equal(text.includes(forbidden), false); assert.equal(projection.includes(forbidden), false)
  }
  assert.match(text, /不是回执，不能用于 bind\/complete/)
  assert.match(text, /统计值和版本信息也可能敏感/)
  assert.match(renderExport(value), /本地审阅文件：/)
  assert.equal(renderExport(value).includes(value.path), true)
  assert.equal(renderExport(value).includes('SHA-256'), false)
  assert.deepEqual(fs.readFileSync(f.receipt), original)
})

test('share drops nested unknown fields, paths, models, log and free-text sentinels', async t => {
  const f = await receiptFixture(t), secret = 'DO_NOT_SHARE_NESTED_9e45'
  updateRecord(f, (receipt, report) => {
    receipt.unknown = { deep: [secret] }
    receipt.payload.unknown = { deep: [secret] }
    receipt.payload.scope.input.unknown = { deep: [secret] }
    receipt.payload.scope.environment.unknown = secret
    receipt.payload.scope.environment.python.version = secret
    receipt.payload.scope.environment.pandas.version = secret
    report.unknown = { deep: [secret] }
    report.limitations = [secret]
    report.metrics[0].model = secret
    report.execution.unknown = { stdout: secret }
    report.evidence = [{ path: secret, quote: secret, locator: { unknown: secret } }]
  })
  const status = { ...currentPass, run_id: secret, sources: [{ path: secret }], next_step: secret, limitations: [secret], details: { environment: secret }, reason_messages: [secret], checked_at_utc: secret }
  const value = await createExportService(withStatus(f, status)).export(shareArgs(f))
  assert.equal(value.exported, true)
  assert.equal(fileText(value).includes(secret), false)
  assert.equal(JSON.stringify(value.share_summary).includes(secret), false)
  assert.equal(JSON.stringify(value).includes(secret), false)
  assert.equal(value.share_summary.records[0].evidence_count, 1)
})

test('share reasons come only from the known table and unknown codes become unknown', async t => {
  const f = await receiptFixture(t), secret = 'DO_NOT_SHARE_REASON_28ac'
  const status = { ...currentPass, current_verdict: 'REVIEW', gate_passed: null, freshness: 'STALE', reason_codes: ['INPUT_CHANGED', secret, '__proto__', { toString: secret }], reason_messages: [secret] }
  const value = await createExportService(withStatus(f, status)).export(shareArgs(f))
  assert.equal(value.exported, true)
  assert.deepEqual(value.share_summary.records[0].reasons, [{ code: 'INPUT_CHANGED', message: '输入内容或路径已变化' }, { code: null, message: '未知' }])
  assert.equal(fileText(value).includes(secret), false); assert.equal(fileText(value).includes('__proto__'), false)
})

test('share permits only strict release version strings from receipt-bound environment', async t => {
  const f = await receiptFixture(t)
  updateRecord(f, receipt => {
    receipt.payload.scope.environment.node = 'v24.21.0'
    receipt.payload.scope.environment.python.version = '3.11.9'
    receipt.payload.scope.environment.pandas.version = '3.0.6'
  })
  const value = await createExportService(withStatus(f)).export(shareArgs(f))
  assert.deepEqual(value.share_summary.records[0].environment, { node: 'v24.21.0', python: '3.11.9', pandas: '3.0.6' })
})

test('share rejects version suffixes, final newlines, alternate digits and custom values', async t => {
  const f = await receiptFixture(t)
  for (const version of ['3.11.9\n', '3.11.9\r\n', '3.11.9 secret', '3.11.9+local', '3.11.9rc1', ' 3.11.9', '03.11.9', '３.１１.９', '3.11.9/secret', '3.11.9\0', '3.11', '99999.1.1']) {
    updateRecord(f, receipt => {
      receipt.payload.scope.environment.node = version
      receipt.payload.scope.environment.python.version = version
      receipt.payload.scope.environment.pandas.version = version
    })
    const value = await createExportService(withStatus(f)).export(shareArgs(f))
    assert.equal(value.exported, true)
    assert.deepEqual(value.share_summary.records[0].environment, { node: null, python: null, pandas: null }, JSON.stringify(version))
  }
  updateRecord(f, receipt => {
    receipt.payload.scope.environment.node = '24.21.0'
    receipt.payload.scope.environment.python.version = 'v3.11.9'
    receipt.payload.scope.environment.pandas.version = 'v3.0.6'
  })
  const value = await createExportService(withStatus(f)).export(shareArgs(f))
  assert.deepEqual(value.share_summary.records[0].environment, { node: '24.21.0', python: null, pandas: null })
})

test('share omits invalid numeric values and non-array counts instead of serializing them', async t => {
  const f = await receiptFixture(t), secret = 'DO_NOT_SHARE_METRIC_694f'
  updateRecord(f, (receipt, report) => {
    receipt.payload.scope.thresholds.faith = secret
    receipt.payload.scope.thresholds.ctx = 2
    report.metrics = [{ primary: true, pos_faithfulness: -1, pos_context_precision: secret }]
    report.evidence = { length: secret }
  })
  const value = await createExportService(withStatus(f)).export(shareArgs(f)), record = value.share_summary.records[0]
  assert.deepEqual(record.thresholds, { faith: null, ctx: null })
  assert.deepEqual(record.metrics, { pos_faithfulness: null, pos_context_precision: null })
  assert.equal(record.evidence_count, null); assert.equal(fileText(value).includes(secret), false)
})

test('share preserves an actually confirmed current FAIL', async t => {
  const f = await receiptFixture(t, 'fail')
  const value = await createExportService(f.options).export(shareArgs(f)), record = value.share_summary.records[0]
  assert.equal(record.current_verdict, 'FAIL'); assert.equal(record.historical_verdict, 'FAIL')
  assert.match(fileText(value), /当前状态：失败（FAIL）/)
})

test('share distinguishes current REVIEW from an archived FAIL after input changes', async t => {
  const f = await receiptFixture(t, 'fail')
  fs.appendFileSync(f.input, ' ')
  const value = await createExportService(f.options).export(shareArgs(f)), record = value.share_summary.records[0]
  assert.equal(record.current_verdict, 'REVIEW'); assert.equal(record.historical_verdict, 'FAIL')
  assert.match(fileText(value), /当前状态：待复核（REVIEW）/)
  assert.match(fileText(value), /历史裁决：失败（FAIL）/)
})

test('share names multiple records by order and never copies their identifiers', async t => {
  const f = await receiptFixture(t), second = await createReplayService(f.options).replay({ result_path: f.input })
  const value = await createExportService(f.options).export({ run_ids: [second.run_id, f.report.run_id], format: 'share' })
  assert.equal(value.exported, true)
  assert.deepEqual(value.share_summary.records.map(x => x.record), ['记录1', '记录2'])
  for (const id of [f.report.run_id, second.run_id]) assert.equal(fileText(value).includes(id), false)
  assert.deepEqual(value.run_ids, []); assert.deepEqual(value.current, [])
})

test('share still refuses corrupt receipts without creating a share file', async t => {
  const f = await receiptFixture(t)
  fs.writeFileSync(f.receipt, '{}')
  const value = await createExportService(f.options).export(shareArgs(f))
  assert.equal(value.exported, false); assert.equal(value.status, 'REVIEW')
  assert.equal(value.share_summary, undefined)
  assert.equal(fs.existsSync(path.join(f.root, 'exports')), false)
})

test('share still verifies original output bytes before projecting', async t => {
  const f = await receiptFixture(t)
  fs.appendFileSync(path.join(path.dirname(f.receipt), 'stdout.txt'), 'tampered')
  const value = await createExportService(f.options).export(shareArgs(f))
  assert.equal(value.exported, false); assert.ok(value.reason_codes.includes('OUTPUT_CHANGED'))
  assert.equal(fs.existsSync(path.join(f.root, 'exports')), false)
})

test('share summary is not accepted as a ReceiptV1 or managed completion authority', async t => {
  const f = await receiptFixture(t), value = await createExportService(f.options).export(shareArgs(f))
  assert.equal(value.share_summary.schema_version, 'GateShareSummaryV1')
  assert.equal(value.share_summary.payload, undefined)
  fs.writeFileSync(f.receipt, JSON.stringify(value.share_summary))
  const status = await f.status.status(f.request)
  assert.equal(status.integrity, 'INVALID'); assert.equal(status.current_verdict, 'REVIEW')
  const managed = createManagedService(f.options), execution = { agent: { session: { id: 'share-test' } } }
  assert.equal((await managed.bind({ task_id: 'task', run_id: f.report.run_id }, execution)).accepted, false)
  assert.equal((await managed.complete({ task_id: 'task', run_id: f.report.run_id }, execution)).accepted, false)
})

test('share does not change original md or byte-identical JSON export behavior', async t => {
  const f = await receiptFixture(t), original = fs.readFileSync(f.receipt), svc = createExportService(f.options)
  const before = await svc.export({ run_id: f.report.run_id, format: 'json' })
  await svc.export(shareArgs(f))
  const after = await svc.export({ run_id: f.report.run_id, format: 'json' })
  const md = await svc.export({ run_id: f.report.run_id, format: 'md' })
  assert.deepEqual(fs.readFileSync(before.path), original); assert.deepEqual(fs.readFileSync(after.path), original)
  assert.deepEqual(fs.readFileSync(f.receipt), original)
  assert.equal(fileText(md).includes(f.input.replaceAll('&', '&amp;')), true)
  assert.deepEqual(before.run_ids, [f.report.run_id]); assert.equal(before.current.length, 1)
  assert.equal(before.share_summary, undefined); assert.ok(before.sha256)
})

test('share cancellation creates no file or partially projected records', async t => {
  const f = await receiptFixture(t), ac = new AbortController(); ac.abort()
  const value = await createExportService(f.options).export(shareArgs(f), { signal: ac.signal })
  assert.equal(value.exported, false); assert.ok(value.reason_codes.includes('CANCELLED'))
  assert.deepEqual(value.run_ids, []); assert.deepEqual(value.current, [])
  assert.equal(value.share_summary, undefined); assert.equal(value.sha256, null)
})

test('share operational errors do not echo unknown error codes', async t => {
  const f = await receiptFixture(t), secret = 'DO_NOT_SHARE_ERROR_a6c4'
  const value = await createExportService({ ...f.options, statusService: { async status() { throw new ReviewError(secret, secret) } } }).export(shareArgs(f))
  assert.equal(value.exported, false); assert.equal(JSON.stringify(value).includes(secret), false)
  assert.deepEqual(value.reason_messages, ['未知'])
})
