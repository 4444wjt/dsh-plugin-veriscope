import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfiguration, validateArguments } from '../lib/config.js'
import { readArchive, parseLocatedJson, sourceEvidence, verifyEvidence, verifyContract } from '../lib/source.js'
import { setup, temporary } from './helpers.js'

test('explicit environment paths resolve without shell expansion and expose provenance', t => {
  const f = setup(t)
  const config = resolveConfiguration(f.options.env)
  assert.equal(config.veriscopeRoot, fs.realpathSync(f.root))
  assert.equal(config.pythonPath, fs.realpathSync(process.execPath))
  assert.deepEqual(config.sources, { veriscopeRoot: 'environment', pythonPath: 'environment' })
})
for (const value of ['', '   ', 'relative/python.exe']) test(`explicit Python configuration rejects ${JSON.stringify(value)}`, t => {
  const f = setup(t)
  assert.throws(() => resolveConfiguration({ ...f.options.env, VERISCOPE_PYTHON: value }), /绝对路径/)
})
test('invalid explicit interpreter does not fall back to venv', t => {
  const f = setup(t)
  fs.mkdirSync(path.join(f.root, 'venv/Scripts'), { recursive: true })
  fs.writeFileSync(path.join(f.root, 'venv/Scripts/python.exe'), '')
  assert.throws(() => resolveConfiguration({ ...f.options.env, VERISCOPE_PYTHON: path.join(f.root, 'absent.exe') }), /Python 解释器/)
})
test('venv probe uses .venv before venv; absence never selects PATH', t => {
  const f = setup(t)
  assert.throws(() => resolveConfiguration({ VERISCOPE_ROOT: f.root }), /禁止回退/)
  const suffix = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  for (const name of ['venv', '.venv']) { fs.mkdirSync(path.join(f.root, name, suffix[0]), { recursive: true }); fs.writeFileSync(path.join(f.root, name, ...suffix), '') }
  const config = resolveConfiguration({ VERISCOPE_ROOT: f.root })
  assert.equal(config.pythonPath, path.join(f.root, '.venv', ...suffix))
  assert.equal(config.sources.pythonPath, 'venv_probe')
})
test('missing root configuration uses the documented default or reports its absence', () => {
  if (process.platform === 'win32' && fs.existsSync('D:\\RAG_Evaluation_Demo\\scripts\\gate_replay.py')) {
    const config = resolveConfiguration({ VERISCOPE_PYTHON: process.execPath })
    assert.equal(config.sources.veriscopeRoot, 'default')
    assert.equal(config.veriscopeRoot, fs.realpathSync('D:\\RAG_Evaluation_Demo'))
  } else assert.throws(() => resolveConfiguration({ VERISCOPE_PYTHON: process.execPath }), /根目录|VERISCOPE_ROOT/)
})
for (const value of [NaN, Infinity, -Infinity, -0.01, 1.01, '0.8', null]) test(`threshold rejects ${String(value)} (${typeof value})`, () => {
  assert.throws(() => validateArguments({ result_path: 'a.json', faith: value }, process.cwd()), /有限数值/)
})
test('threshold endpoints and exact defaults retained', () => {
  assert.equal(validateArguments({ result_path: 'x' }, process.cwd()).faith, 0.8)
  assert.equal(validateArguments({ result_path: 'x', faith: 0, ctx: 1 }, process.cwd()).faith, 0)
  assert.throws(() => validateArguments({ result_path: 'x', unexpected: true }, process.cwd()), /不支持/)
})
test('raw JSON locations retain escaped literals and encoded pointer keys', t => {
  const root = temporary(t), file = path.join(root, 'escaped.json')
  fs.writeFileSync(file, '{"summary":[{"model":"\\u6a21\\u578b","faithfulness":0.9}],"a/b~c":"\\u4e2d"}')
  const archive = readArchive(file, 1000)
  const evidence = sourceEvidence(archive, '/summary/0/model', 'result')
  assert.equal(evidence.quote, '"\\u6a21\\u578b"')
  assert.ok(verifyEvidence(evidence, archive))
  assert.equal(parseLocatedJson(fs.readFileSync(file, 'utf8')).locations.has('/a~1b~0c'), true)
  assert.equal(verifyEvidence({ ...evidence, quote: '"模型"' }, archive), false)
  assert.equal(verifyEvidence({ ...evidence, sha256: '0'.repeat(64) }, archive), false)
})
for (const value of ['{"summary":[],"summary":[]}', '{"summary":[],"x":NaN}', '{"summary":[],"x":1e999}', '{"summary":[]} trailing', '{"summary":[}', '{"x":"bad\nstring"}']) test('malformed/duplicate/nonfinite JSON remains invalid: ' + value.slice(0, 32), () => {
  assert.throws(() => parseLocatedJson(value))
})
test('archive size is enforced before parsing; directories and missing summary rejected', t => {
  const f = setup(t)
  assert.throws(() => readArchive(f.input, 2), /超过/)
  assert.throws(() => readArchive(f.root, 1000))
  fs.writeFileSync(f.input, '{}')
  assert.throws(() => readArchive(f.input, 1000), /summary/)
})
test('wrapper preserves correct evidence JSON pointer', t => {
  const f = setup(t)
  fs.writeFileSync(f.input, JSON.stringify({ result: f.value }))
  const archive = readArchive(f.input, 10000)
  assert.equal(archive.prefix, '/result')
  assert.equal(sourceEvidence(archive, '/result/summary/0/pos_faithfulness', 'result').quote, '0.8607')
})
test('upstream file changes invalidate the audited contract', t => {
  const f = setup(t)
  verifyContract(f.root, f.contract)
  fs.appendFileSync(path.join(f.root, 'scripts/gate_replay.py'), '# changed')
  assert.throws(() => verifyContract(f.root, f.contract), /版本变化/)
})
test('primary model preserves input order and skips only explicitly invalid models', t => {
  const f = setup(t)
  f.value.summary.unshift({ model: 'failed-model', faithfulness: null, context_precision: null })
  f.value.summary.push({ model: 'higher-scoring-model', faithfulness: 1, context_precision: 1, pos_faithfulness: 1, pos_context_precision: 1 })
  fs.writeFileSync(f.input, JSON.stringify(f.value))
  const archive = readArchive(f.input, 10000)
  assert.equal(archive.primaryIndex, 1)
  assert.equal(archive.primary.model, 'deepseek-chat')
})
