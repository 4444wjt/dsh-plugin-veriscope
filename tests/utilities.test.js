import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { receiptFixture } from './fusion-helpers.js'
import { setup, temporary } from './helpers.js'
import { reasonMessage } from '../lib/reasons.js'
import { createDoctorService } from '../lib/doctor.js'
import { createListService } from '../lib/catalog.js'
import { createBatchService } from '../lib/batch.js'
import { createExportService } from '../lib/export.js'
import { createReplayService } from '../lib/replay.js'
import { renderStatus } from '../lib/status.js'

test('doctor ready is not a gate PASS and does not execute the gate', async t => {
  const f = await receiptFixture(t), before = f.calls.length
  const d = await createDoctorService(f.options).doctor()
  assert.equal(d.status, 'READY'); assert.equal(d.ready, true)
  assert.ok(d.items.every(x => x.status === 'ok'))
  assert.ok(f.calls.slice(before).every(x => x.args.includes('-c')))
  assert.equal(d.new_evaluation_model_calls, 0)
  assert.equal(fs.readdirSync(f.root).some(n => n.startsWith('.doctor-')), false)
})
test('doctor missing interpreter preserves healthy root and supplies Chinese repair command', async t => {
  const f = setup(t)
  f.options.env.VERISCOPE_PYTHON = path.join(f.root, 'missing.exe')
  const d = await createDoctorService(f.options).doctor()
  assert.equal(d.status, 'REVIEW'); assert.equal(d.ready, false)
  assert.equal(d.items.find(x => x.check === 'root_readable').status, 'ok')
  assert.equal(d.items.find(x => x.check === 'gate_script').status, 'ok')
  assert.ok(d.items.some(x => x.status === 'fail' && x.suggestion?.includes('$env:VERISCOPE_PYTHON')))
  assert.equal(f.calls.length, 0)
})
test('doctor detects tampered upstream script', async t => {
  const f = await receiptFixture(t)
  fs.appendFileSync(path.join(f.root, 'scripts/gate_replay.py'), '# changed')
  const d = await createDoctorService(f.options).doctor()
  assert.equal(d.status, 'REVIEW'); assert.equal(d.items.find(x => x.check === 'gate_script').status, 'fail')
})
test('doctor rejects empty contract instead of treating zero files as verified', async t => {
  const f = setup(t)
  const d = await createDoctorService({ ...f.options, contract: { files: {} } }).doctor()
  assert.equal(d.items.find(x => x.check === 'contract').status, 'fail')
  assert.equal(d.items.find(x => x.check === 'gate_script').status, 'fail')
})
test('doctor broken newest receipt is a failure, never environment ready', async t => {
  const f = await receiptFixture(t)
  fs.writeFileSync(f.receipt, '{bad')
  const d = await createDoctorService(f.options).doctor()
  assert.equal(d.status, 'REVIEW'); assert.equal(d.items.find(x => x.check === 'recent_receipt').status, 'fail')
})
test('doctor unwritable state target never reports ready', async t => {
  const f = setup(t), file = path.join(f.root, 'state-is-file')
  fs.writeFileSync(file, 'no directory')
  const d = await createDoctorService({ ...f.options, artifactsDir: undefined, env: { ...f.options.env, VERISCOPE_STATE_DIR: file } }).doctor()
  assert.equal(d.status, 'REVIEW'); assert.equal(d.items.find(x => x.check === 'state_writable').status, 'fail')
})
test('doctor unknown arguments and cancelled calls cannot be ready', async t => {
  const f = setup(t)
  assert.equal((await createDoctorService(f.options).doctor({ install: true })).ready, false)
  const ac = new AbortController(); ac.abort()
  assert.equal((await createDoctorService(f.options).doctor({}, { signal: ac.signal })).ready, false)
})
test('Chinese reasons preserve raw unknown code without invented meaning', () => {
  assert.match(reasonMessage('INVALID_CONFIGURATION'), /配置无效/)
  assert.equal(reasonMessage('FUTURE_CODE'), 'FUTURE_CODE（未收录）')
  assert.equal(reasonMessage('__proto__'), '__proto__（未收录）')
})
test('status exposes receipt details and Chinese reasons', async t => {
  const f = await receiptFixture(t), s = await f.status.status(f.request)
  assert.equal(s.details.thresholds.faith, 0.8); assert.equal(s.details.input.path, f.input)
  assert.equal(s.details.environment.python, 'mock')
  assert.match(renderStatus(s), /绑定项未变化/); assert.match(renderStatus(s), /BINDINGS_UNCHANGED/)
})
test('list empty store is read-only and has no fake PASS', async t => {
  const root = temporary(t), runs = path.join(root, 'runs')
  const v = await createListService({ artifactsDir: runs }).list()
  assert.equal(v.status, 'OK'); assert.equal(v.returned, 0); assert.equal(fs.existsSync(runs), false)
})
test('list preserves damaged receipt separately and checks current validity', async t => {
  const f = await receiptFixture(t), id = randomUUID(), directory = path.join(f.root, 'runs', id)
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'receipt.json'), 'bad')
  const value = await createListService(f.options).list()
  assert.equal(value.scanned, 2); assert.equal(value.damaged.length, 1); assert.equal(value.damaged[0].run_id, id)
  assert.equal(value.items.find(i => i.run_id === f.report.run_id).current_verdict, 'PASS')
  fs.appendFileSync(f.input, ' ')
  assert.equal((await createListService(f.options).list()).items.find(i => i.run_id === f.report.run_id).current_verdict, 'REVIEW')
})
test('list returns newest first, explicit limit and retains all scan damage', async t => {
  const f = await receiptFixture(t), service = createReplayService(f.options)
  await new Promise(r => setTimeout(r, 2))
  const second = await service.replay({ result_path: f.input })
  const v = await createListService(f.options).list({ limit: 1 })
  assert.equal(v.items.length, 1); assert.equal(v.items[0].run_id, second.run_id); assert.equal(v.scanned, 2)
  assert.equal((await createListService(f.options).list({ limit: 0 })).status, 'REVIEW')
  assert.equal((await createListService(f.options).list({ limit: 201 })).status, 'REVIEW')
})
test('list retains invalid directory names without following them', async t => {
  const f = await receiptFixture(t)
  fs.mkdirSync(path.join(f.root, 'runs', 'not-a-run'))
  const v = await createListService(f.options).list()
  assert.ok(v.damaged.some(r => r.entry === 'not-a-run' && r.reason_codes.includes('RUN_DIRECTORY_INVALID')))
})
test('list catches output tampering even if receipt parses', async t => {
  const f = await receiptFixture(t)
  fs.appendFileSync(path.join(path.dirname(f.receipt), 'stdout.txt'), 'tampered')
  const v = await createListService(f.options).list()
  assert.equal(v.items[0].current_verdict, 'REVIEW'); assert.equal(v.damaged.length, 1)
})
test('batch PASS FAIL bad JSON is 1/1/0/1 and overall FAIL', async t => {
  const pass = setup(t), fail = setup(t, { kind: 'fail' }), bad = path.join(pass.root, 'bad.json')
  fs.writeFileSync(bad, '{bad')
  const p = createReplayService(pass.options), f = createReplayService(fail.options)
  const v = await createBatchService({ ...pass.options, replayService: { replay: (args, e) => args.result_path === fail.input ? f.replay(args, e) : p.replay(args, e) } }).batch({ paths: [pass.input, fail.input, bad] })
  assert.deepEqual(v.counts, { pass: 1, fail: 1, review: 0, error: 1 }); assert.equal(v.status, 'FAIL'); assert.equal(v.processed, 3)
})
for (const [statuses, expected] of [[['PASS', 'PASS'], 'PASS'], [['PASS', 'REVIEW'], 'REVIEW'], [['FAIL', 'REVIEW'], 'FAIL']]) test(`batch precedence ${statuses.join('/')} => ${expected}`, async t => {
  const f = setup(t); let i = 0, active = 0, max = 0
  const svc = createBatchService({ ...f.options, replayService: { async replay() { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 1)); active--; return { status: statuses[i++], run_id: randomUUID(), execution: { command: {}, process: {}, errors: [] } } } } })
  const v = await svc.batch({ paths: ['a.json', 'b.json'] })
  assert.equal(v.status, expected); assert.equal(max, 1)
})
test('batch continues after thrown replay and distinguishes operational error', async t => {
  const f = setup(t); let calls = 0
  const v = await createBatchService({ ...f.options, replayService: { async replay() { if (!calls++) throw new Error('oops'); return { status: 'PASS', execution: { command: {}, errors: [] } } } } }).batch({ paths: ['a', 'b'] })
  assert.equal(v.status, 'REVIEW'); assert.equal(v.counts.error, 1); assert.equal(v.counts.pass, 1)
})
test('batch cancellation keeps previous FAIL and leaves unstarted denominator visible', async t => {
  const f = setup(t), ac = new AbortController()
  const v = await createBatchService({ ...f.options, replayService: { async replay() { ac.abort(); return { status: 'FAIL', execution: { command: {}, errors: [] } } } } }).batch({ paths: ['a', 'b'] }, { signal: ac.signal })
  assert.equal(v.status, 'FAIL'); assert.equal(v.cancelled, true); assert.equal(v.requested, 2); assert.equal(v.processed, 1)
})
test('batch cancelled during final PASS cannot return overall PASS', async t => {
  const f = setup(t), ac = new AbortController()
  const v = await createBatchService({ ...f.options, replayService: { async replay() { ac.abort(); return { status: 'PASS', execution: { command: {}, errors: [] } } } } }).batch({ paths: ['a'] }, { signal: ac.signal })
  assert.equal(v.status, 'REVIEW'); assert.equal(v.cancelled, true); assert.equal(v.counts.pass, 1)
})
test('batch dir is nonrecursive and rejects empty, excess and conflicting inputs', async t => {
  const f = setup(t); const svc = createBatchService(f.options)
  fs.mkdirSync(path.join(f.root, 'nested')); fs.writeFileSync(path.join(f.root, 'nested', 'ignored.json'), '{}')
  assert.equal((await svc.batch({ dir: path.join(f.root, 'nested'), paths: [f.input] })).status, 'REVIEW')
  assert.equal((await svc.batch({ paths: [] })).status, 'REVIEW')
  assert.ok((await svc.batch({ paths: Array(201).fill(f.input) })).reason_codes.includes('BATCH_LIMIT'))
  assert.ok((await svc.batch({ paths: [f.input], faith: 2 })).reason_codes.includes('INVALID_ARGUMENT'))
  const v = await svc.batch({ dir: f.root }); assert.equal(v.requested, 1)
})
test('export JSON single receipt is byte identical, repeated exports never overwrite', async t => {
  const f = await receiptFixture(t), svc = createExportService(f.options), args = { run_id: f.report.run_id, format: 'json' }
  const a = await svc.export(args), b = await svc.export(args)
  assert.equal(a.exported, true); assert.notEqual(a.path, b.path)
  assert.deepEqual(fs.readFileSync(a.path), fs.readFileSync(f.receipt)); assert.deepEqual(fs.readFileSync(a.path), fs.readFileSync(b.path))
  assert.equal(path.dirname(a.path), path.join(f.root, 'exports'))
})
test('export Markdown shows current REVIEW separately from historical PASS after change', async t => {
  const f = await receiptFixture(t)
  fs.appendFileSync(f.input, ' ')
  const v = await createExportService(f.options).export({ run_id: f.report.run_id, format: 'md' })
  assert.equal(v.exported, true)
  const md = fs.readFileSync(v.path, 'utf8')
  assert.match(md, /当前状态：待复核（REVIEW）/); assert.match(md, /历史裁决：通过（PASS）/)
  assert.match(md, /正向 Faithfulness/); assert.match(md, /证据条数/); assert.match(md, /限制/)
})
test('export multiple receipts retains exact objects and original order', async t => {
  const f = await receiptFixture(t), second = await createReplayService(f.options).replay({ result_path: f.input })
  const v = await createExportService(f.options).export({ run_ids: [f.report.run_id, second.run_id], format: 'json' })
  const data = JSON.parse(fs.readFileSync(v.path, 'utf8'))
  assert.equal(data.length, 2); assert.deepEqual(data[0], JSON.parse(fs.readFileSync(f.receipt, 'utf8')))
  assert.equal(data[1].payload.run_id, second.run_id)
})
test('export corrupt receipt refuses all-or-nothing and leaves no exported file', async t => {
  const f = await receiptFixture(t), id = randomUUID(), directory = path.join(f.root, 'runs', id)
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, 'receipt.json'), '{}')
  const v = await createExportService(f.options).export({ run_ids: [f.report.run_id, id], format: 'json' })
  assert.equal(v.exported, false); assert.equal(fs.existsSync(path.join(f.root, 'exports')), false)
})
test('export rejects path traversal, unknown format, duplicate and ambiguous IDs', async t => {
  const f = await receiptFixture(t), svc = createExportService(f.options), id = f.report.run_id
  for (const args of [{ run_id: '../x', format: 'json' }, { run_id: id, run_ids: [id], format: 'md' }, { run_id: id, format: 'html' }, { run_ids: [id, id], format: 'json' }, { run_id: id, format: 'md', path: 'evil' }]) assert.equal((await svc.export(args)).exported, false)
})
test('export cancellation does not create a partial report', async t => {
  const f = await receiptFixture(t), ac = new AbortController(); ac.abort()
  const v = await createExportService(f.options).export({ run_id: f.report.run_id, format: 'md' }, { signal: ac.signal })
  assert.equal(v.exported, false); assert.ok(v.reason_codes.includes('CANCELLED'))
})
test('export refuses redirected exports directory without touching its target', async t => {
  const f = await receiptFixture(t), outside = temporary(t), link = path.join(f.root, 'exports')
  try { fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir') } catch (e) { if (e.code === 'EPERM') return t.skip('Symlink creation unavailable'); throw e }
  const v = await createExportService(f.options).export({ run_id: f.report.run_id, format: 'md' })
  assert.equal(v.exported, false); assert.ok(v.reason_codes.includes('STATE_PATH_ESCAPE'))
  assert.equal(fs.readdirSync(outside).length, 0)
})
test('new card details render text, preserve one read-only button and unknown fields', () => {
  let component
  const React = { createElement: (tag, props, ...children) => ({ tag, props, children }), useState: initial => [initial, () => {}], useRef: () => ({}), useCallback: f => f, useEffect() {} }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: ({ factory }) => { factory(() => React).apply({ slots: { inject: (_n, f) => [...f()], register: (_v, c) => { component = c } } }) } } } })
  const tree = component({ block: { meta: { veriscope: { run_id: 'x', session_id: 's' } } } }), all = JSON.stringify(tree)
  assert.match(all, /回执绑定环境/); assert.match(all, /输入摘要/); assert.match(all, /回执阈值/)
  assert.equal((all.match(/"tag":"button"/g) ?? []).length, 1)
  assert.match(all, /"data-veriscope-status":"REVIEW"/)
})
