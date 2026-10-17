import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createReplayService, renderReport } from '../lib/replay.js'
import { decideStatus } from '../lib/parser.js'
import { describeHistoricalTrace } from '../lib/trace.js'
import { readArchive, sha256 } from '../lib/source.js'
import { setup } from './helpers.js'

for (const kind of ['pass', 'fail']) test(`frozen real stdout + protocol mock returns ${kind}, with append-only evidence`, async t => {
  const f = setup(t, { kind }), before = sha256(fs.readFileSync(f.input))
  const service = createReplayService(f.options)
  const a = await service.replay({ result_path: f.input }), b = await service.replay({ result_path: f.input })
  assert.equal(a.status, kind.toUpperCase())
  assert.equal(a.gate_passed, kind === 'pass')
  assert.equal(a.exit_code, kind === 'pass' ? 0 : 1)
  assert.notEqual(a.run_id, b.run_id)
  assert.equal(sha256(fs.readFileSync(f.input)), before)
  for (const report of [a, b]) assert.equal(JSON.parse(fs.readFileSync(path.join(report.execution.artifacts_path, 'report.json'))).status, report.status)
  assert.ok(a.evidence.length >= 7)
  assert.equal(a.judge_provenance.judge_model, null)
  assert.equal(a.judge_provenance.route_relation, 'unknown')
  assert.equal(a.execution.new_evaluation_model_calls, 0)
  assert.equal(f.calls[1].options.timeoutMs, 120000)
  assert.equal(f.calls[1].args[0], '-B')
  assert.equal(f.calls[1].args.includes(f.input), false)
  assert.ok(renderReport(a).includes(kind === 'pass' ? '状态：通过' : '状态：失败'))
})
for (const kind of ['pass', 'fail']) test(`broken extra output preserves known FAIL; PASS requires full evidence (${kind})`, async t => {
  const f = setup(t, { kind })
  f.options.runner = async (file, args, opts) => args.includes('-c') ? f.runner(file, args, opts) : { ...f.processResult, stdout: f.processResult.stdout.replace('  正向忠实度 faithfulness:', 'broken metric:') }
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, kind === 'fail' ? 'FAIL' : 'REVIEW')
  assert.ok(report.execution.errors.length)
})
test('Python traceback with exit 1 is an execution REVIEW, not a confirmed quality FAIL', async t => {
  const f = setup(t, { kind: 'fail' })
  f.options.runner = async (file, args, opts) => args.includes('-c') ? f.runner(file, args, opts) : { ...f.processResult, stdout: '', stderr: 'Traceback: missing dependency or malformed archive' }
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, 'REVIEW')
  assert.equal(report.gate_passed, null)
  assert.equal(report.exit_code, 1)
})
test('summary missing positive context cannot be PASS even when Python passes', async t => {
  const f = setup(t, { mutate: value => { value.model_dfs = {} } })
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, 'REVIEW')
  assert.equal(report.exit_code, 0)
  assert.ok(report.execution.errors.some(x => x.code === 'POSITIVE_CONTEXT_UNVERIFIED'))
})
test('no valid model/input failure and unknown code never pass', async t => {
  for (const code of [2, 3, null]) {
    const f = setup(t)
    f.options.runner = async (file, args, opts) => args.includes('-c') ? f.runner(file, args, opts) : { ...f.processResult, code }
    const report = await createReplayService(f.options).replay({ result_path: f.input })
    assert.equal(report.status, 'REVIEW')
  }
})
test('configuration failure and invalid JSON never execute a subprocess', async t => {
  const f = setup(t)
  const badConfig = createReplayService({ ...f.options, env: { ...f.options.env, VERISCOPE_PYTHON: '' } })
  assert.equal((await badConfig.replay({ result_path: f.input })).status, 'REVIEW')
  fs.writeFileSync(f.input, '{')
  assert.equal((await createReplayService(f.options).replay({ result_path: f.input })).status, 'REVIEW')
  assert.equal(f.calls.length, 0)
})
test('changed script stops before interpreter or replay', async t => {
  const f = setup(t)
  fs.appendFileSync(path.join(f.root, 'scripts/gate_replay.py'), '\nchanged')
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, 'REVIEW')
  assert.equal(f.calls.length, 0)
})
test('dead venv is REVIEW with no replay; no implicit fallback', async t => {
  const f = setup(t)
  f.options.runner = async () => ({ ...f.processResult, code: 103, stdout: '', stderr: 'No Python' })
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, 'REVIEW')
  assert.equal(report.exit_code, null)
  assert.equal(report.execution.errors[0].code, 'PYTHON_UNAVAILABLE')
})
for (const reason of ['timeout', 'cancelled', 'output_limit', 'spawn_error']) test(`${reason} with an incidental exit 1 is REVIEW, not a quality FAIL`, () => {
  assert.equal(decideStatus({ code: 1, reason, error: null, signal: null }, { gate: false }, []), 'REVIEW')
})
test('source changing during replay is recorded and cannot pass', async t => {
  const f = setup(t)
  f.options.runner = async (file, args, options) => {
    const result = await f.runner(file, args, options)
    if (!args.includes('-c')) fs.appendFileSync(f.input, ' ')
    return result
  }
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, 'REVIEW')
  assert.ok(report.execution.errors.some(x => x.code === 'SOURCE_CHANGED'))
})
test('baseline bytes are snapshotted and regression can block an absolute PASS', async t => {
  const f = setup(t)
  f.options.runner = async (file, args, options) => {
    const result = await f.runner(file, args, options)
    return args.includes('-c') ? result : { ...result, code: 1, stdout: result.stdout + '\n🔁 相对基线的回归对比：local\n⛔ 相对基线确定退步，拦截\n' }
  }
  const report = await createReplayService(f.options).replay({ result_path: f.input, baseline: f.input })
  assert.equal(report.status, 'FAIL')
  assert.equal(report.execution.baseline.sha256, sha256(fs.readFileSync(f.input)))
  assert.ok(f.calls[1].args.includes('--baseline'))
})
for (const kind of ['pass', 'fail']) test(`artifact collision is visible and cannot hide ${kind}`, async t => {
  const f = setup(t, { kind })
  f.options.runner = async (file, args, options) => {
    const result = await f.runner(file, args, options)
    if (!args.includes('-c')) {
      const directory = path.join(f.options.artifactsDir, fs.readdirSync(f.options.artifactsDir)[0])
      fs.writeFileSync(path.join(directory, 'stdout.txt'), 'collision')
    }
    return result
  }
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, kind === 'fail' ? 'FAIL' : 'REVIEW')
})
test('historical statements, rejected claims and missing anchors are retained without new support judgments', t => {
  const raw = { statements: [{ text: '甲', verdict: 'supported', evidence: '不存在' }, { text: '乙', verdict: 'supported', evidence: '原文' }], trace_diagnostics: { rejected_statements: [{ text: '拒绝条目' }] } }
  const f = setup(t, { mutate: value => { value.model_dfs['deepseek-chat'][0].hallucination_trace = JSON.stringify(raw) } })
  const trace = describeHistoricalTrace(readArchive(f.input, 10000))
  assert.equal(trace.rejudged, false)
  assert.equal(trace.rows[0].statements.length, 2)
  assert.equal(trace.rows[0].statements[0].anchor_status, 'missing_or_unmatched')
  assert.equal(trace.rows[0].statements[1].anchor_status, 'literal_present')
  assert.ok(trace.rows[0].raw.includes('拒绝条目'))
})
test('environment credentials are never serialized into reports or process logs', async t => {
  const f = setup(t)
  const sentinel = 'local-test-secret-do-not-log-42'
  f.options.env = { ...f.options.env, DASHSCOPE_API_KEY: sentinel, UNRELATED_ACCESS_TOKEN: sentinel }
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, 'PASS')
  for (const file of ['report.json', 'stdout.txt', 'stderr.txt']) assert.equal(fs.readFileSync(path.join(report.execution.artifacts_path, file), 'utf8').includes(sentinel), false)
})
