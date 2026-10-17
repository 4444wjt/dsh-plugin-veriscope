import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { ReviewError } from './errors.js'
import { sha256, verifyContract } from './source.js'
import { resolveConfiguration, LIMITS } from './config.js'
import { runBoundedProcess } from './process.js'
import { selectContract } from './contracts.js'

export const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const RECEIPT_FILES = Object.freeze([
  'package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'contracts/upstream.json', 'skills/dsh-plugin-veriscope/SKILL.md',
  'lib/config.js', 'lib/errors.js', 'lib/source.js', 'lib/process.js', 'lib/parser.js',
  'lib/trace.js', 'lib/replay.js', 'lib/schema.js', 'lib/receipt.js', 'lib/status.js',
  'lib/managed.js', 'lib/bridge.js',
  'lib/reasons.js', 'lib/catalog.js', 'lib/doctor.js', 'lib/batch.js', 'lib/export.js', 'lib/changes.js',
  'mcp.js', 'lib/mcp.js', 'lib/tools.js', 'lib/contracts.js', 'contracts/upstream-lf.json', 'lib/dsh-sdk.js',
  'lib/builtin-rules.js', 'lib/builtin-receipt.js', 'lib/builtin.js', 'scripts/check.mjs',
  'schemas/gate-archive-v1.schema.json', 'schemas/gate-policy-v1.schema.json',
])
export const PROBE = 'import json,sys,pandas,hashlib,importlib.metadata as m; d=m.distribution("pandas"); print(json.dumps({"version":sys.version.split()[0],"pandas":pandas.__version__,"executable":sys.executable,"pandas_metadata_sha256":hashlib.sha256((d.read_text("METADATA") or "").encode()).hexdigest()}))'

export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  return JSON.stringify(value)
}
export const digest = value => sha256(canonical(value))
export function validRunId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ReviewError('INVALID_RUN_ID', 'run_id 必须为 UUID。')
  return value.toLowerCase()
}
function inside(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}
export function storePaths(options = {}, create = false) {
  const env = options.env ?? process.env
  const pluginRoot = options.pluginRoot ?? PACKAGE_ROOT
  let root = path.join(pluginRoot, '.local'), source = 'plugin_default'
  if (options.requireExplicitStateDir && !Object.hasOwn(env, 'VERISCOPE_STATE_DIR')) throw new ReviewError('INVALID_STATE_DIR', '此入口必须显式设置 VERISCOPE_STATE_DIR 为持久状态目录的非空绝对路径；不会回退到插件包或 npx 缓存。')
  if (Object.hasOwn(env, 'VERISCOPE_STATE_DIR')) {
    root = env.VERISCOPE_STATE_DIR; source = 'environment'
    if (typeof root !== 'string' || !root.trim() || !path.isAbsolute(root) || root.includes('\0')) throw new ReviewError('INVALID_STATE_DIR', 'VERISCOPE_STATE_DIR 必须为非空绝对路径。')
  }
  let runs = options.requireExplicitStateDir ? path.join(root, 'runs') : options.artifactsDir ?? path.join(root, 'runs')
  if (!options.requireExplicitStateDir && options.artifactsDir) { root = path.dirname(runs); source = 'service_override' }
  if (create) { fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(runs, { recursive: true }) }
  const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root)
  if (fs.existsSync(runs) && !inside(realRoot, fs.realpathSync(runs))) throw new ReviewError('STATE_PATH_ESCAPE', '运行目录超出状态根。')
  return { stateRoot: realRoot, runsDir: path.resolve(runs), source }
}
export function locateRun(options, runId) {
  const id = validRunId(runId), store = storePaths(options)
  const directory = path.join(store.runsDir, id)
  if (fs.existsSync(directory)) {
    if (fs.lstatSync(directory).isSymbolicLink() || !inside(store.stateRoot, fs.realpathSync(directory))) throw new ReviewError('STATE_PATH_ESCAPE', '拒绝越界链接或运行目录重定向。')
  }
  return { ...store, directory, runId: id }
}

export function readBounded(filename, limit) {
  let handle
  try {
    handle = fs.openSync(filename, 'r')
    const before = fs.fstatSync(handle)
    if (!before.isFile() || before.size > limit) throw new ReviewError('FILE_LIMIT', '文件类型或读取上限不符。')
    const data = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < data.length) { const n = fs.readSync(handle, data, length, data.length - length, null); if (!n) break; length += n }
    if (length !== before.size || fs.fstatSync(handle).size !== before.size) throw new ReviewError('CHECK_RACE', '检查时文件发生变化。')
    return data.subarray(0, length)
  } finally { if (handle !== undefined) fs.closeSync(handle) }
}
export function fingerprint(filename, limit) {
  const realPath = fs.realpathSync(filename), bytes = readBounded(realPath, limit)
  return { path: path.resolve(filename), real_path: realPath, sha256: sha256(bytes), bytes: bytes.length }
}
export async function probeEnvironment(config, options = {}, signal) {
  const runner = options.runner ?? runBoundedProcess
  const result = await runner(config.pythonPath, ['-B', '-c', PROBE], { cwd: config.veriscopeRoot, signal, timeoutMs: 10_000, outputBytes: 16_384, env: options.env ?? process.env })
  if (result.code !== 0 || result.reason || result.error || result.signal) throw new ReviewError('ENVIRONMENT_UNAVAILABLE', '无法确认 Python／pandas 环境。')
  let value
  try { value = JSON.parse(result.stdout) } catch { throw new ReviewError('ENVIRONMENT_UNAVAILABLE', '环境探测输出无效。') }
  if (!['version', 'pandas', 'executable'].every(k => typeof value[k] === 'string' && value[k]) || !/^[a-f0-9]{64}$/.test(value.pandas_metadata_sha256)) throw new ReviewError('ENVIRONMENT_UNAVAILABLE', '环境描述缺少版本或 pandas 发行元数据。')
  if (fs.realpathSync(value.executable) !== fs.realpathSync(config.pythonPath)) throw new ReviewError('ENVIRONMENT_UNAVAILABLE', 'Python 实际路径与配置不符。')
  return { node: process.version, python: { ...fingerprint(value.executable, 128 * 1024 * 1024), version: value.version }, pandas: { version: value.pandas, metadata_sha256: value.pandas_metadata_sha256 } }
}
function staticScope(input, options, config, selected) {
  const root = options.pluginRoot ?? PACKAGE_ROOT
  const fileMap = Object.fromEntries(RECEIPT_FILES.map(rel => [rel, sha256(readBounded(path.join(root, rel), 4 * 1024 * 1024))]))
  const pkg = JSON.parse(readBounded(path.join(root, 'package.json'), 65536))
  return {
    input: fingerprint(input.result_path, LIMITS.inputBytes), baseline: input.baseline ? fingerprint(input.baseline, LIMITS.inputBytes) : null,
    thresholds: { faith: input.faith, ctx: input.ctx },
    upstream: { root: config.veriscopeRoot, contract_id: selected.contractId, contract_sha256: digest(selected.contract), files: verifyContract(config.veriscopeRoot, selected.contract) },
    plugin: { root: fs.realpathSync(root), version: pkg.version, files: fileMap, coverage: [...RECEIPT_FILES] },
  }
}
export async function captureScope(input, options = {}, signal, knownEnvironment) {
  if (signal?.aborted) throw new ReviewError('CANCELLED', '检查已取消。')
  const config = resolveConfiguration(options.env ?? process.env, options)
  const selected = selectContract(config.veriscopeRoot, options)
  const first = staticScope(input, options, config, selected)
  const environment = knownEnvironment ?? await probeEnvironment(config, options, signal)
  const second = staticScope(input, options, config, selected)
  if (digest(first) !== digest(second) || signal?.aborted) throw new ReviewError('CHECK_RACE', '检查过程中绑定项发生变化或请求取消。')
  return { ...second, environment }
}

export function writeReceipt(directory, report, scope) {
  if (!report.execution.command || ![0, 1, 2].includes(report.exit_code) || !scope) throw new ReviewError('NO_EXECUTED_REPLAY', '没有实际执行的门禁，不能生成回执。')
  const outputs = {}
  for (const name of ['report.json', 'stdout.txt', 'stderr.txt']) {
    const data = readBounded(path.join(directory, name), name === 'report.json' ? 32 * 1024 * 1024 : LIMITS.outputBytes)
    outputs[name] = { sha256: sha256(data), bytes: data.length }
  }
  const payload = { run_id: report.run_id, created_at_utc: new Date().toISOString(), historical_verdict: report.status,
    scope, scope_digest: digest(scope), outputs }
  const receipt = { schema_version: 'ReceiptV1', payload, integrity_sha256: digest(payload) }
  const temporary = path.join(directory, `.receipt-${randomUUID()}.tmp`)
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600)
    try { fs.writeFileSync(handle, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
    fs.linkSync(temporary, path.join(directory, 'receipt.json')) // exclusive atomic publication, never replace a receipt
  } finally { try { fs.unlinkSync(temporary) } catch {} }
  return receipt
}
