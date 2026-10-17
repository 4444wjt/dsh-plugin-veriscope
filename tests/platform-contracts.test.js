import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveConfiguration } from '../lib/config.js'
import { CONTRACT_FILES, loadContractProfiles, selectContract } from '../lib/contracts.js'
import { sha256 } from '../lib/source.js'
import { storePaths, RECEIPT_FILES, digest, probeEnvironment } from '../lib/receipt.js'
import { createDoctorService } from '../lib/doctor.js'
import { createReplayService } from '../lib/replay.js'
import { createStatusService } from '../lib/status.js'
import { createListService } from '../lib/catalog.js'
import { compareScopeChanges } from '../lib/changes.js'
import { setup, temporary } from './helpers.js'
import { receiptFixture } from './fusion-helpers.js'

function profiles(t) {
  const root = temporary(t), pluginRoot = temporary(t), original = {}, lf = {}
  fs.mkdirSync(path.join(pluginRoot, 'contracts'))
  for (const relative of CONTRACT_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
    const bytes = Buffer.from(`# audited fixture ${relative}\r\n`)
    fs.writeFileSync(path.join(root, relative), bytes)
    original[relative] = sha256(bytes); lf[relative] = sha256(Buffer.from(bytes.toString().replaceAll('\r\n', '\n')))
  }
  for (const [filename, contract, files] of [['upstream.json', 'original', original], ['upstream-lf.json', 'lf', lf]]) fs.writeFileSync(path.join(pluginRoot, 'contracts', filename), JSON.stringify({ contract, files }))
  return { root, pluginRoot, original, lf }
}

for (const platform of ['win32', 'linux', 'darwin']) test(`venv resolution follows ${platform} conventions and prioritizes .venv`, t => {
  const f = setup(t), suffix = platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  for (const name of ['venv', '.venv']) { fs.mkdirSync(path.join(f.root, name, suffix[0]), { recursive: true }); fs.writeFileSync(path.join(f.root, name, ...suffix), '') }
  const config = resolveConfiguration({ VERISCOPE_ROOT: f.root }, { platform })
  assert.equal(config.pythonPath, path.join(f.root, '.venv', ...suffix))
  assert.equal(config.sources.pythonPath, 'venv_probe')
})
for (const platform of ['linux', 'darwin']) test(`non-Windows ${platform} refuses missing root without probing Windows default`, () => {
  assert.throws(() => resolveConfiguration({ VERISCOPE_PYTHON: process.execPath }, { platform }), /必须显式设置 VERISCOPE_ROOT/)
})

for (const source of ['environment', 'venv_probe']) test(`POSIX venv symlink retains launch path and bound binary (${source})`, { skip: process.platform === 'win32' }, async t => {
  const f = setup(t), executable = path.join(f.root, '.venv', 'bin', 'python')
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.symlinkSync(process.execPath, executable)
  const env = { VERISCOPE_ROOT: f.root, ...(source === 'environment' ? { VERISCOPE_PYTHON: executable } : {}) }
  const config = resolveConfiguration(env, { platform: 'linux' })
  assert.equal(config.pythonPath, executable)
  assert.equal(config.sources.pythonPath, source)
  const result = await probeEnvironment(config, { runner: f.runner, env })
  assert.equal(f.calls[0].executable, executable)
  assert.equal(result.python.path, executable)
  assert.equal(result.python.real_path, fs.realpathSync(process.execPath))
})

test('MCP state cannot fall back through artifactsDir or create a plugin default', t => {
  const pluginRoot = temporary(t), artifactsDir = path.join(pluginRoot, 'escape-runs')
  for (const create of [false, true]) assert.throws(() => storePaths({ pluginRoot, artifactsDir, env: {}, requireExplicitStateDir: true }, create), error => error.code === 'INVALID_STATE_DIR')
  assert.equal(fs.existsSync(path.join(pluginRoot, '.local')), false)
  assert.equal(fs.existsSync(artifactsDir), false)
})
test('explicit MCP state takes precedence over service artifacts overrides', t => {
  const root = temporary(t), explicit = path.join(root, 'persistent'), override = path.join(root, 'ignored')
  const result = storePaths({ env: { VERISCOPE_STATE_DIR: explicit }, artifactsDir: override, requireExplicitStateDir: true }, true)
  assert.equal(result.stateRoot, explicit); assert.equal(result.runsDir, path.join(explicit, 'runs')); assert.equal(result.source, 'environment')
  assert.equal(fs.existsSync(override), false)
})
for (const candidate of ['', 'relative', null, 7, 'bad\0path']) test(`invalid explicit MCP state rejected: ${JSON.stringify(candidate)}`, t => {
  const root = temporary(t)
  assert.throws(() => storePaths({ env: { VERISCOPE_STATE_DIR: candidate }, artifactsDir: path.join(root, 'runs'), requireExplicitStateDir: true }, true), error => error.code === 'INVALID_STATE_DIR')
  assert.deepEqual(fs.readdirSync(root), [])
})
test('all four services refuse missing MCP state without creating fallback state', async t => {
  const f = setup(t), options = { ...f.options, pluginRoot: temporary(t), requireExplicitStateDir: true }
  const replay = await createReplayService(options).replay({ result_path: f.input })
  const doctor = await createDoctorService(options).doctor()
  const status = await createStatusService(options).status({ run_id: randomUUID() })
  const list = await createListService(options).list()
  assert.equal(replay.status, 'REVIEW'); assert.ok(replay.execution.errors.some(e => e.code === 'INVALID_STATE_DIR'))
  assert.equal(doctor.status, 'REVIEW'); assert.ok(doctor.items.some(e => e.reason_code === 'INVALID_STATE_DIR'))
  assert.equal(status.current_verdict, 'REVIEW'); assert.ok(status.reason_codes.includes('INVALID_STATE_DIR'))
  assert.equal(list.status, 'REVIEW'); assert.ok(list.reason_codes.includes('INVALID_STATE_DIR'))
  assert.equal(fs.existsSync(path.join(options.pluginRoot, '.local')), false)
  assert.equal(fs.existsSync(options.artifactsDir), false)
})

test('DSH retains plugin default unless an explicit state root is provided', t => {
  const pluginRoot = temporary(t)
  assert.deepEqual(storePaths({ env: {}, pluginRoot }), { stateRoot: path.join(pluginRoot, '.local'), runsDir: path.join(pluginRoot, '.local', 'runs'), source: 'plugin_default' })
  assert.equal(fs.existsSync(path.join(pluginRoot, '.local')), false)
})
test('doctor uses POSIX hints and reports actual state root provenance', async t => {
  const f = setup(t), state = path.join(f.root, 'persistent')
  const options = { ...f.options, platform: 'linux', artifactsDir: undefined, env: { ...f.options.env, VERISCOPE_STATE_DIR: state, VERISCOPE_PYTHON: path.join(f.root, 'missing') } }
  const value = await createDoctorService(options).doctor()
  assert.equal(value.items.find(i => i.check === 'root_readable').status, 'ok')
  assert.ok(value.items.some(i => i.suggestion?.includes('export VERISCOPE_PYTHON=')))
  assert.ok(value.items.every(i => !i.suggestion?.includes('$env:')))
  assert.deepEqual(value.state, { root: state, source: 'environment' })
})

test('complete original and LF profiles select independently without normalizing runtime bytes', t => {
  const f = profiles(t)
  assert.equal(selectContract(f.root, f).contractId, 'original')
  for (const relative of CONTRACT_FILES) { const file = path.join(f.root, relative); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n')) }
  assert.equal(selectContract(f.root, f).contractId, 'lf')
})
test('mixed original and LF upstream files cannot be stitched into an accepted contract', t => {
  const f = profiles(t), filename = path.join(f.root, CONTRACT_FILES[0])
  fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replaceAll('\r\n', '\n'))
  assert.throws(() => selectContract(f.root, f), error => error.code === 'CONTRACT_MISMATCH')
})
test('fixed replay contract rejects switching from accepted original to accepted LF mid-run', t => {
  const f = profiles(t), selectedContract = selectContract(f.root, f)
  for (const relative of CONTRACT_FILES) { const file = path.join(f.root, relative); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n')) }
  assert.equal(selectContract(f.root, f).contractId, 'lf')
  assert.throws(() => selectContract(f.root, { ...f, selectedContract }), error => error.code === 'CONTRACT_MISMATCH')
})
test('contract comparison is byte-based even if upstream mtime is preserved', t => {
  const f = profiles(t), file = path.join(f.root, CONTRACT_FILES[0]), stat = fs.statSync(file)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('audited', 'changed')); fs.utimesSync(file, stat.atime, stat.mtime)
  assert.throws(() => selectContract(f.root, f), error => error.code === 'CONTRACT_MISMATCH')
})
test('profile files must contain a complete reviewed file set', t => {
  const f = profiles(t), filename = path.join(f.pluginRoot, 'contracts', 'upstream-lf.json'), data = JSON.parse(fs.readFileSync(filename))
  delete data.files[CONTRACT_FILES[1]]; fs.writeFileSync(filename, JSON.stringify(data))
  assert.throws(() => loadContractProfiles(f), error => error.code === 'CONTRACT_INVALID')
})
test('new protocol entrypoints and both contract profiles are receipt-bound', () => {
  for (const relative of ['mcp.js', 'lib/mcp.js', 'lib/tools.js', 'lib/contracts.js', 'lib/dsh-sdk.js', 'contracts/upstream.json', 'contracts/upstream-lf.json']) assert.ok(RECEIPT_FILES.includes(relative), relative)
})
test('legacy contract identifiers remain optional explanatory fields', () => {
  const base = { upstream: { root: '/upstream', contract_sha256: 'a'.repeat(64), files: { 'scripts/gate_replay.py': 'a'.repeat(64) } } }
  const changes = compareScopeChanges(base, { ...base, upstream: { ...base.upstream, contract_id: 'audited-python-stdout-v1' } })
  assert.ok(changes.items.some(item => item.field === 'upstream.contract_id' && item.before === '未记录'))
  assert.ok(!changes.unverified_groups.includes('upstream'))
})
test('replay records the selected contract identifier and null MCP session without adding receipt session fields', async t => {
  const f = setup(t)
  f.options.requireExplicitStateDir = true
  f.options.env.VERISCOPE_STATE_DIR = path.join(f.root, 'persistent')
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  assert.equal(report.status, 'PASS'); assert.equal(report.execution.session_id, null)
  const receipt = JSON.parse(fs.readFileSync(path.join(report.execution.artifacts_path, 'receipt.json')))
  assert.equal(receipt.payload.scope.upstream.contract_id, 'service-override')
  assert.equal(report.execution.contract.id, 'service-override')
  assert.equal(Object.hasOwn(receipt.payload, 'session_id'), false)
})
test('new adapter byte changes invalidate receipts even when mtime is preserved', async t => {
  const root = temporary(t)
  for (const relative of RECEIPT_FILES) { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.copyFileSync(new URL('../' + relative, import.meta.url), path.join(root, relative)) }
  const f = await receiptFixture(t, 'pass', { pluginRoot: root }), filename = path.join(root, 'lib/mcp.js'), stat = fs.statSync(filename)
  const bytes = fs.readFileSync(filename); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(filename, bytes); fs.utimesSync(filename, stat.atime, stat.mtime)
  const status = await f.status.status(f.request)
  assert.equal(status.historical_verdict, 'PASS'); assert.equal(status.current_verdict, 'REVIEW'); assert.ok(status.reason_codes.includes('PLUGIN_CHANGED'))
})
test('legacy receipts without contract identifier retain historical verdict but become stale after coverage upgrade', async t => {
  const f = await receiptFixture(t), receipt = JSON.parse(fs.readFileSync(f.receipt))
  delete receipt.payload.scope.upstream.contract_id
  const newer = ['mcp.js', 'lib/mcp.js', 'lib/tools.js', 'lib/contracts.js', 'contracts/upstream-lf.json']
  receipt.payload.scope.plugin.coverage = receipt.payload.scope.plugin.coverage.filter(relative => !newer.includes(relative))
  for (const relative of newer) delete receipt.payload.scope.plugin.files[relative]
  receipt.payload.scope_digest = digest(receipt.payload.scope); receipt.integrity_sha256 = digest(receipt.payload)
  fs.writeFileSync(f.receipt, JSON.stringify(receipt))
  const status = await f.status.status(f.request)
  assert.equal(status.integrity, 'VALID'); assert.equal(status.historical_verdict, 'PASS'); assert.equal(status.current_verdict, 'REVIEW'); assert.equal(status.freshness, 'STALE')
  assert.ok(status.reason_codes.includes('EXECUTOR_CHANGED')); assert.ok(status.reason_codes.includes('PLUGIN_CHANGED'))
})
