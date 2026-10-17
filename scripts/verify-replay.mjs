import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createReplayService } from '../lib/replay.js'
import { runBoundedProcess } from '../lib/process.js'
import { readArchive, sha256 } from '../lib/source.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = path.join(root, '.local', 'verification', `replay-${randomUUID()}`)
fs.mkdirSync(out, { recursive: true })
const results = []
async function verify() {
const service = createReplayService()
assert.ok(service.configuration, '先设置可用的 VERISCOPE_ROOT / VERISCOPE_PYTHON')
const config = service.configuration
const cases = [
  ['historical-fail', 'docs/competition/evidence/20261005T144504Z-full-39511424/api-response.json', 'FAIL', true],
  ['historical-pass', 'docs/competition/evidence/20261014T073859Z-full-1c6f091f/api-response.json', 'PASS', true],
  ['historical-second-fail', 'docs/competition/evidence/20261014T125415Z-full-a5002d4f/api-response.json', 'FAIL', true],
  ['boundary', path.join(root, 'tests/fixtures/boundary.json'), 'PASS', false],
  ['below-boundary', path.join(root, 'tests/fixtures/below-boundary.json'), 'FAIL', false],
  ['missing-positive', path.join(root, 'tests/fixtures/missing-positive.json'), 'FAIL', false],
  ['negative-excluded', path.join(root, 'tests/fixtures/negative-excluded.json'), 'PASS', false],
  ['below-context', path.join(root, 'tests/fixtures/below-context.json'), 'FAIL', false],
  ['first-valid-model', path.join(root, 'tests/fixtures/first-valid-model.json'), 'FAIL', false],
]
for (const [name, filename, expected, historical] of cases) {
  const source = path.resolve(config.veriscopeRoot, filename)
  const before = sha256(fs.readFileSync(source))
  const direct = await runBoundedProcess(config.pythonPath, ['-B', config.scriptPath, source, '--faith', '0.8', '--ctx', '0.8'], { cwd: config.veriscopeRoot })
  const report = await service.replay({ result_path: source })
  fs.writeFileSync(path.join(out, `${name}.direct.stdout.txt`), direct.stdout, { flag: 'wx' })
  fs.writeFileSync(path.join(out, `${name}.direct.stderr.txt`), direct.stderr, { flag: 'wx' })
  assert.equal(report.status, expected, `${name}: ${JSON.stringify(report.execution.errors)}`)
  assert.equal(report.exit_code, direct.code)
  const archive = readArchive(source, 10 * 1024 * 1024)
  assert.equal(report.metrics.find(item => item.primary).pos_faithfulness, archive.primary.pos_faithfulness)
  assert.equal(report.metrics.find(item => item.primary).pos_context_precision, archive.primary.pos_context_precision)
  assert.equal(before, sha256(fs.readFileSync(source)), '原文件不得变化')
  results.push({ name, type: historical ? 'real_archive' : 'constructed_regression', expected, actual: report.status, direct_exit: direct.code, adapter_exit: report.exit_code, metrics: report.metrics, sha256: before, path: source, run_id: report.run_id, artifacts: report.execution.artifacts_path, python: report.execution.python })
  console.log(JSON.stringify({ name, status: report.status, direct_exit: direct.code }))
}
const self = await service.replay({ result_path: cases[1][1], baseline: cases[1][1] })
assert.equal(self.status, 'PASS', JSON.stringify(self.execution.errors))
results.push({ name: 'real_baseline_self', type: 'real_archive', actual: self.status, artifacts: self.execution.artifacts_path })

const regression = value => ({ summary: [{ model: 'fixture-model', faithfulness: value, context_precision: value, pos_faithfulness: value, pos_context_precision: value }], model_dfs: { 'fixture-model': Array.from({ length: 10 }, (_, i) => ({ question: `构造配对题${i}`, answer: '构造回答', contexts: ['构造依据'], case_type: 'positive', faithfulness: value, context_precision: value, context_recall: 1 })) } })
const previous = path.join(out, 'regression-baseline.json'), next = path.join(out, 'regression-candidate.json')
fs.writeFileSync(previous, JSON.stringify(regression(1)))
fs.writeFileSync(next, JSON.stringify(regression(0.85)))
const absolute = await service.replay({ result_path: next })
const relative = await service.replay({ result_path: next, baseline: previous })
assert.equal(absolute.status, 'PASS')
assert.equal(relative.status, 'FAIL', JSON.stringify(relative.execution.errors))
results.push({ name: 'constructed_confirmed_regression', absolute: absolute.status, relative: relative.status, artifacts: relative.execution.artifacts_path })

// A process audit hook proves the replay can run while socket/DNS access is denied.
const guard = path.join(out, 'network-denied')
fs.mkdirSync(guard, { recursive: true })
fs.writeFileSync(path.join(guard, 'sitecustomize.py'), 'import sys\ndef guard(event,args):\n    if event in ("socket.connect","socket.getaddrinfo"):\n        raise RuntimeError("network denied by local acceptance harness")\nsys.addaudithook(guard)\n')
const guardedEnv = { ...process.env, PYTHONPATH: guard, PYTHONDONTWRITEBYTECODE: '1', PYTHON_DOTENV_DISABLED: '1' }
const denied = await runBoundedProcess(config.pythonPath, ['-B', '-c', 'import socket; socket.create_connection(("127.0.0.1", 9))'], { cwd: root, env: guardedEnv })
assert.notEqual(denied.code, 0)
assert.ok(denied.stderr.includes('network denied by local acceptance harness'))
const guarded = await createReplayService({ env: guardedEnv }).replay({ result_path: cases[1][1] })
assert.equal(guarded.status, 'PASS', JSON.stringify(guarded.execution.errors))
results.push({ name: 'network_denied_replay', denial_control_exit: denied.code, actual: guarded.status, artifacts: guarded.execution.artifacts_path })

const record = path.join(out, 'replay-acceptance.json')
fs.writeFileSync(record, JSON.stringify({ created_at_utc: new Date().toISOString(), method: 'direct original Python versus adapter, no model calls', results, new_model_calls: 0 }, null, 2) + '\n')
console.log(JSON.stringify({ verified: true, checks: results.length, record }))
}
verify().catch(error => {
  const record = path.join(out, 'failure.json')
  fs.writeFileSync(record, JSON.stringify({ created_at_utc: new Date().toISOString(), results, verified: false, error: { name: error.name, message: error.message }, new_model_calls: 0 }, null, 2) + '\n', { flag: 'wx' })
  console.error(JSON.stringify({ verified: false, record, error: error.message }))
  process.exitCode = 1
})
