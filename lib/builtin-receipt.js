import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ReviewError } from './errors.js'
import { LIMITS } from './config.js'
import { parseLocatedJson, sha256 } from './source.js'
import { PACKAGE_ROOT, RECEIPT_FILES, digest, fingerprint, readBounded, storePaths } from './receipt.js'
import { BUILTIN_ENGINE, BUILTIN_FORMATS, validatePolicy, normalizeArchive } from './builtin-rules.js'

export const BUILTIN_FILES = Object.freeze([...RECEIPT_FILES])
export const BUILTIN_OUTPUTS = Object.freeze(['report.json', 'input.json', 'policy.json', 'normalized.json'])
export const explicitBuiltinOptions = options => ({ ...options, requireExplicitStateDir: true })

export function builtinStore(options = {}, create = false) {
  const strict = explicitBuiltinOptions(options), env = strict.env ?? process.env
  if (typeof env.VERISCOPE_STATE_DIR === 'string' && fs.existsSync(env.VERISCOPE_STATE_DIR) && fs.lstatSync(env.VERISCOPE_STATE_DIR).isSymbolicLink()) throw new ReviewError('STATE_PATH_ESCAPE', 'B2 状态根不得为符号链接。')
  const store = storePaths(strict, create)
  if (fs.existsSync(store.runsDir) && fs.lstatSync(store.runsDir).isSymbolicLink()) throw new ReviewError('STATE_PATH_ESCAPE', '运行目录不得为符号链接。')
  return store
}

export function checkArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['archive_path', 'policy_path', 'format'].includes(key))) throw new ReviewError('INVALID_ARGUMENT', '提供 archive_path、policy_path 和可选 format；不接受会话或执行器参数。')
  for (const key of ['archive_path', 'policy_path']) if (typeof args[key] !== 'string' || !args[key].trim() || !path.isAbsolute(args[key]) || args[key].includes('\0')) throw new ReviewError('INVALID_ARGUMENT', '归档和策略工具参数必须是非空绝对路径。')
  const format = args.format ?? 'gate-archive-v1'
  if (!BUILTIN_FORMATS.includes(format)) throw new ReviewError('BUILTIN_FORMAT_UNSUPPORTED', '未知输入布局；不会自动猜测或切换格式。')
  return { archive_path: path.resolve(args.archive_path), policy_path: path.resolve(args.policy_path), format }
}

function snapshot(filename, limit) {
  const realPath = fs.realpathSync(filename), bytes = readBounded(realPath, limit)
  if (realPath !== fs.realpathSync(filename)) throw new ReviewError('CHECK_RACE', '读取期间来源路径发生变化。')
  return { bytes, fingerprint: { path: path.resolve(filename), real_path: realPath, bytes: bytes.length, sha256: sha256(bytes) } }
}
const json = bytes => parseLocatedJson(new TextDecoder('utf8', { fatal: true }).decode(bytes)).value
function runtimeScope(options) {
  const root = options.pluginRoot ?? PACKAGE_ROOT
  const files = Object.fromEntries(BUILTIN_FILES.map(relative => [relative, sha256(readBounded(path.join(root, relative), 4 * 1024 * 1024))]))
  const pkg = json(readBounded(path.join(root, 'package.json'), 65536))
  return { plugin: { root: fs.realpathSync(root), version: pkg.version, files, coverage: [...BUILTIN_FILES] },
    environment: { node: process.version, platform: process.platform, arch: process.arch, executable: fs.realpathSync(process.execPath) } }
}

export function captureBuiltinInputs(input, options) {
  const firstRuntime = runtimeScope(options)
  const archiveFile = snapshot(input.archive_path, LIMITS.inputBytes), policyFile = snapshot(input.policy_path, 1024 * 1024)
  const policy = validatePolicy(json(policyFile.bytes)), archive = normalizeArchive(json(archiveFile.bytes), policy, input.format)
  const runtime = runtimeScope(options)
  if (digest(firstRuntime) !== digest(runtime)) throw new ReviewError('CHECK_RACE', '读取期间插件或 Node 环境发生变化。')
  const scope = { engine: { ...BUILTIN_ENGINE }, adapter: { id: input.format, version: '1.0.0' }, input: archiveFile.fingerprint,
    policy: policyFile.fingerprint, normalized_sha256: digest(archive), policy_spec_sha256: digest(policy), ...runtime }
  return { archive, policy, archiveBytes: archiveFile.bytes, policyBytes: policyFile.bytes, scope }
}

// Status only fingerprints sources and code; it never executes a second
// judgment. Identical bytes + adapter + policy bind the recorded normalization.
export function captureBuiltinCurrentScope(original, options) {
  return { ...original, engine: { ...BUILTIN_ENGINE }, adapter: { id: original.adapter.id, version: '1.0.0' },
    input: fingerprint(original.input.path, LIMITS.inputBytes), policy: fingerprint(original.policy.path, 1024 * 1024), ...runtimeScope(options) }
}

export function writeBuiltinReceipt(directory, report, scope) {
  if (report.schema_version !== 'BuiltinGateReportV1' || report.execution?.executed !== true || !scope || report.engine?.id !== BUILTIN_ENGINE.id
    || !['PASS', 'FAIL', 'REVIEW'].includes(report.status)) throw new ReviewError('NO_EXECUTED_CHECK', '未实际执行 B2 判定，不能生成回执。')
  const outputs = Object.fromEntries(BUILTIN_OUTPUTS.map(name => {
    const bytes = readBounded(path.join(directory, name), 32 * 1024 * 1024)
    return [name, { sha256: sha256(bytes), bytes: bytes.length }]
  }))
  const payload = { run_id: report.run_id, created_at_utc: new Date().toISOString(), historical_verdict: report.status,
    engine: { ...BUILTIN_ENGINE }, scope, scope_digest: digest(scope), outputs }
  const receipt = { schema_version: 'ReceiptV2', payload, integrity_sha256: digest(payload) }
  const temporary = path.join(directory, `.receipt-${randomUUID()}.tmp`)
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600)
    try { fs.writeFileSync(handle, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
    fs.linkSync(temporary, path.join(directory, 'receipt.json'))
  } finally { try { fs.unlinkSync(temporary) } catch {} }
  return receipt
}

export function readBuiltinRecord(run, raw, receipt, options) {
  builtinStore(options)
  const p = receipt.payload, scope = p?.scope
  if (!p || p.run_id !== run.runId || !['PASS', 'FAIL', 'REVIEW'].includes(p.historical_verdict) || digest(p) !== receipt.integrity_sha256
    || !scope || digest(scope) !== p.scope_digest || digest(p.engine) !== digest(BUILTIN_ENGINE) || digest(scope.engine) !== digest(BUILTIN_ENGINE)
    || !BUILTIN_FORMATS.includes(scope.adapter?.id) || scope.adapter.version !== '1.0.0' || !scope.input || !scope.policy || !scope.plugin || !scope.environment
    || typeof scope.normalized_sha256 !== 'string' || typeof scope.policy_spec_sha256 !== 'string' || !p.outputs
    || Object.keys(p.outputs).length !== BUILTIN_OUTPUTS.length) throw new ReviewError('RECEIPT_INVALID', 'ReceiptV2 版本、判定器、绑定项或摘要无效。')
  const contents = {}
  for (const name of BUILTIN_OUTPUTS) {
    const filename = path.join(run.directory, name)
    if (fs.lstatSync(filename).isSymbolicLink()) throw new ReviewError('STATE_PATH_ESCAPE', 'B2 输出记录不得重定向。')
    const bytes = readBounded(filename, 32 * 1024 * 1024)
    if (bytes.length !== p.outputs[name]?.bytes || sha256(bytes) !== p.outputs[name]?.sha256) throw new ReviewError('OUTPUT_CHANGED', 'B2 原报告或输入快照已变化。')
    contents[name] = bytes
  }
  const report = json(contents['report.json']), normalized = json(contents['normalized.json']), policy = validatePolicy(json(contents['policy.json']))
  if (report.schema_version !== 'BuiltinGateReportV1' || report.run_id !== p.run_id || report.status !== p.historical_verdict
    || report.gate_passed !== (report.status === 'REVIEW' ? null : report.status === 'PASS') || report.execution?.executed !== true
    || digest(report.engine) !== digest(p.engine) || digest(policy) !== scope.policy_spec_sha256 || digest(report.policy) !== digest(policy)
    || sha256(contents['input.json']) !== scope.input.sha256 || contents['input.json'].length !== scope.input.bytes
    || sha256(contents['policy.json']) !== scope.policy.sha256 || contents['policy.json'].length !== scope.policy.bytes
    || digest(normalized) !== scope.normalized_sha256
    || digest(normalizeArchive(json(contents['input.json']), policy, scope.adapter.id)) !== scope.normalized_sha256) throw new ReviewError('RECEIPT_INVALID', 'B2 报告、策略或规范化快照与回执不一致。')
  return { run, raw, receipt, report }
}

export function builtinScopeChanges(before, after) {
  const groups = [['input', '输入', 'INPUT_CHANGED'], ['policy', '策略', 'POLICY_CHANGED'], ['normalized_sha256', '规范化数据', 'INPUT_CHANGED'],
    ['policy_spec_sha256', '规则定义', 'POLICY_CHANGED'], ['engine', '判定器', 'EXECUTOR_CHANGED'], ['adapter', '适配器', 'EXECUTOR_CHANGED'],
    ['plugin', '插件代码', 'PLUGIN_CHANGED'], ['environment', 'Node 环境', 'ENVIRONMENT_CHANGED']]
  const changed = groups.filter(([key]) => digest(before[key]) !== digest(after[key]))
  return { reason_codes: [...new Set(changed.map(([, , code]) => code))], changes: { state: 'COMPLETE',
    items: changed.map(([field, label]) => ({ field, label, before: '原绑定值', after: '已变化' })),
    total: changed.length, truncated: false, limit: 20, unverified_groups: [] } }
}
