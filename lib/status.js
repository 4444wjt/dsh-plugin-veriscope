import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { ReviewError } from './errors.js'
import { sha256, parseLocatedJson } from './source.js'
import { captureScope, digest, locateRun, readBounded, validRunId } from './receipt.js'
import { reasonMessages, renderReasons } from './reasons.js'
import { compareScopeChanges, unverifiedChanges, renderChanges } from './changes.js'

export const STATUS_LIMITATIONS = [
  '仅确认查询时所列绑定项；未封存全部传递依赖和操作系统，检查后仍可能变化。',
  '摘要用于可信本地记录的变化检测，不提供外部签名或抗整体恶意重写保证。',
  '不重新评分或调用评测模型；普通聊天与外部发布不受此完成入口控制。',
]
function statusArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['run_id', 'faith', 'ctx', 'baseline_run_id'].includes(k))) throw new ReviewError('INVALID_ARGUMENT', '状态参数无效或包含未知字段。')
  validRunId(args.run_id)
  for (const key of ['faith', 'ctx']) if (Object.hasOwn(args, key) && (typeof args[key] !== 'number' || !Number.isFinite(args[key]) || args[key] < 0 || args[key] > 1)) throw new ReviewError('INVALID_THRESHOLD', '阈值必须为0–1有限数值。')
  if (Object.hasOwn(args, 'baseline_run_id') && args.baseline_run_id !== null) validRunId(args.baseline_run_id)
}
export function readRecord(args, options) {
  const run = locateRun(options, args.run_id)
  const receiptFile = path.join(run.directory, 'receipt.json')
  if (fs.lstatSync(receiptFile).isSymbolicLink()) throw new ReviewError('STATE_PATH_ESCAPE', '回执不得重定向。')
  const raw = readBounded(receiptFile, 1024 * 1024)
  const receipt = parseLocatedJson(new TextDecoder('utf8', { fatal: true }).decode(raw)).value
  const p = receipt.payload
  if (receipt.schema_version !== 'ReceiptV1' || !p || p.run_id !== run.runId || !['PASS', 'FAIL', 'REVIEW'].includes(p.historical_verdict) || digest(p) !== receipt.integrity_sha256 || digest(p.scope) !== p.scope_digest) throw new ReviewError('RECEIPT_INVALID', '回执版本、结构或摘要校验失败。')
  if (!p.scope?.input || !p.scope?.thresholds || !p.outputs || !p.scope?.plugin || !p.scope.environment) throw new ReviewError('RECEIPT_INVALID', '回执字段不完整。')
  for (const name of ['report.json', 'stdout.txt', 'stderr.txt']) {
    const filename = path.join(run.directory, name)
    if (fs.lstatSync(filename).isSymbolicLink()) throw new ReviewError('STATE_PATH_ESCAPE', '输出记录不得重定向。')
    const bytes = readBounded(filename, name === 'report.json' ? 32 * 1024 * 1024 : 2 * 1024 * 1024)
    if (sha256(bytes) !== p.outputs[name]?.sha256 || bytes.length !== p.outputs[name]?.bytes) throw new ReviewError('OUTPUT_CHANGED', '原报告或原始日志已变化。')
  }
  if (fs.lstatSync(receiptFile).isSymbolicLink()) throw new ReviewError('STATE_PATH_ESCAPE', '回执不得重定向。')
  const report = JSON.parse(readBounded(path.join(run.directory, 'report.json'), 32 * 1024 * 1024))
  if (report.run_id !== p.run_id || report.status !== p.historical_verdict || report.gate_passed !== (report.status === 'PASS' ? true : report.status === 'FAIL' ? false : null)) throw new ReviewError('RECEIPT_INVALID', '原报告与回执裁决不一致。')
  return { run, raw, receipt, report }
}
export function createStatusService(options = {}) {
  return {
    async status(args, { signal, _baseline = false } = {}) {
      const start = performance.now()
      const value = { schema_version: 'GateStatusV1', run_id: typeof args?.run_id === 'string' ? args.run_id : null,
        historical_verdict: 'unknown', current_verdict: 'REVIEW', gate_passed: null,
        freshness: 'UNKNOWN', integrity: 'UNKNOWN', reason_codes: [], checked_at_utc: new Date().toISOString(),
        scope_digest: null, sources: [], details: null, changes: unverifiedChanges(), reason_messages: [], next_step: '请重新执行门禁，生成当前回执。', limitations: [...STATUS_LIMITATIONS], elapsed_ms: 0 }
      try {
        statusArgs(args)
        const { run, raw, receipt, report } = readRecord(args, options), p = receipt.payload
        value.historical_verdict = p.historical_verdict; value.integrity = 'VALID'; value.scope_digest = p.scope_digest
        value.sources = [{ kind: 'receipt', path: path.join(run.directory, 'receipt.json'), sha256: sha256(raw) }, { kind: 'input', ...p.scope.input }]
        value.details = { thresholds: p.scope.thresholds, environment: { node: p.scope.environment.node, python: p.scope.environment.python?.version ?? null, pandas: p.scope.environment.pandas?.version ?? null }, input: p.scope.input }
        const original = p.scope
        const input = { result_path: original.input.path, baseline: original.baseline?.path,
          faith: Object.hasOwn(args, 'faith') ? args.faith : original.thresholds.faith,
          ctx: Object.hasOwn(args, 'ctx') ? args.ctx : original.thresholds.ctx }
        if (Object.hasOwn(args, 'baseline_run_id')) {
          if (args.baseline_run_id === null) input.baseline = undefined
          else {
            if (_baseline || args.baseline_run_id === args.run_id) throw new ReviewError('BASELINE_REFERENCE_INVALID', '基线引用循环或不可确认。')
            const baselineStatus = await this.status({ run_id: args.baseline_run_id }, { signal, _baseline: true })
            if (baselineStatus.freshness !== 'FRESH' || baselineStatus.integrity !== 'VALID') throw new ReviewError('BASELINE_REFERENCE_INVALID', '期望基线的回执当前不可验证。')
            input.baseline = readRecord({ run_id: args.baseline_run_id }, options).receipt.payload.scope.input.path
          }
        }
        const current = await captureScope(input, options, signal)
        for (const [key, code] of [['input', 'INPUT_CHANGED'], ['baseline', 'BASELINE_CHANGED'], ['thresholds', 'POLICY_CHANGED'], ['upstream', 'EXECUTOR_CHANGED'], ['plugin', 'PLUGIN_CHANGED'], ['environment', 'ENVIRONMENT_CHANGED']]) {
          if (digest(original[key]) !== digest(current[key])) value.reason_codes.push(code)
        }
        const second = readRecord(args, options)
        if (sha256(raw) !== sha256(second.raw)) throw new ReviewError('CHECK_RACE', '复验时回执发生变化。')
        value.changes = compareScopeChanges(original, current)
        if (value.reason_codes.length) { value.freshness = 'STALE'; value.next_step = '绑定条件已变化，请使用明确的新策略重新重放；历史裁决保留。' }
        else {
          value.freshness = 'FRESH'; value.current_verdict = report.status
          value.gate_passed = report.status === 'PASS' ? true : report.status === 'FAIL' ? false : null
          value.reason_codes = [report.status === 'REVIEW' ? 'CORE_REVIEW' : 'BINDINGS_UNCHANGED']
          value.next_step = report.status === 'PASS' ? '所列绑定项当前未变；受管任务可通过完成入口再次核验。' : report.status === 'FAIL' ? '门禁仍失败；查看原始依据并修复后重新重放。' : '原门禁待复核；请查看执行错误后重新重放。'
        }
      } catch (error) {
        const code = error instanceof ReviewError ? error.code : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'RECORD_OR_SOURCE_MISSING' : ['EACCES', 'EPERM'].includes(error.code) ? 'RECORD_PERMISSION' : 'RECORD_INVALID'
        value.reason_codes.push(code)
        if (['RECEIPT_INVALID', 'OUTPUT_CHANGED', 'RECORD_INVALID', 'STATE_PATH_ESCAPE'].includes(code)) value.integrity = 'INVALID'
        value.current_verdict = 'REVIEW'; value.gate_passed = null
        value.changes = unverifiedChanges()
      }
      value.elapsed_ms = performance.now() - start
      value.reason_messages = reasonMessages(value.reason_codes)
      return value
    },
  }
}
export function renderStatus(value) {
  const labels = { PASS: '通过', FAIL: '失败', REVIEW: '待复核', unknown: '未知' }
  return [`当前状态：${labels[value.current_verdict]}`, `历史裁决：${labels[value.historical_verdict]}`, value.next_step,
    `原因：${renderReasons(value.reason_codes)}`, ...renderChanges(value.changes), `运行编号：${value.run_id ?? '无效'}`, `检查时间：${value.checked_at_utc}`,
    '检查当前有效性使用 veriscope_gate_status；重新执行门禁使用 veriscope_gate_replay。', ...value.limitations].join('\n')
}
