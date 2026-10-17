import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { ReviewError } from './errors.js'
import { digest } from './receipt.js'
import { BUILTIN_ENGINE, evaluateThresholds } from './builtin-rules.js'
import { builtinStore, checkArguments, captureBuiltinInputs, captureBuiltinCurrentScope, writeBuiltinReceipt } from './builtin-receipt.js'

export const BUILTIN_LIMITATIONS = Object.freeze([
  '只消费已有评分，按显式策略检查全部输入记录的等权均值；不评分、不调用模型。',
  '无法发现导出前已删除的记录；完整性仅针对所提供的输入，不证明原评测全量完整。',
  '来源和单位为提供方声明，不证明评分或回答事实正确，也不等同原 VeriScope 正样本门禁。',
  '回执仅检测可信本地记录的变化；不抵御能整体重写状态根的用户。',
  'B2 不用于 bind/complete，不授权发布；当前有效性须另查 status。',
])
const cancelled = signal => { if (signal?.aborted) throw new ReviewError('CANCELLED', 'B2 检查已取消。') }
const errorCode = error => error instanceof ReviewError ? error.code : ['ENOENT', 'ENOTDIR'].includes(error?.code) ? 'RECORD_OR_SOURCE_MISSING' : ['EACCES', 'EPERM'].includes(error?.code) ? 'RECORD_PERMISSION' : 'BUILTIN_EXECUTION_FAILED'

export function createBuiltinService(options = {}) {
  const fixed = { ...options, env: Object.freeze({ ...(options.env ?? process.env) }), requireExplicitStateDir: true }
  return { async check(args, { signal, sessionId = null } = {}) {
    const started = performance.now()
    const report = { schema_version: 'BuiltinGateReportV1', run_id: randomUUID(), engine: { ...BUILTIN_ENGINE }, status: 'REVIEW', gate_passed: null,
      judgement: null, metrics: [], policy: null, source: null, evidence: [], limitations: [...BUILTIN_LIMITATIONS],
      execution: { executed: false, session_id: sessionId, new_evaluation_model_calls: 0, errors: [], elapsed_ms: 0 } }
    const recording = { receipt_available: false, eligible_at_recording: false, artifacts_path: null }
    let directory
    try {
      const input = checkArguments(args)
      builtinStore(fixed) // validate explicit configuration before reading sources; no directory creation
      cancelled(signal)
      const captured = captureBuiltinInputs(input, fixed)
      report.policy = captured.policy; report.source = { ...captured.archive.source, verification: 'declared_only', format: input.format }
      await setImmediate(); cancelled(signal)
      const result = evaluateThresholds(captured.archive, captured.policy)
      Object.assign(report, result, { judgement: result.status })
      report.execution.executed = true
      report.evidence = result.metrics.map(metric => ({ kind: 'metric_rows', metric: metric.metric,
        input_sha256: captured.scope.input.sha256, policy_sha256: captured.scope.policy.sha256,
        locator: input.format === 'ragas-records-v1' ? { column: metric.metric } : { field: 'rows[].scores', metric: metric.metric },
        total_count: metric.total_count, valid_count: metric.valid_count }))
      await setImmediate(); cancelled(signal)
      if (digest(captured.scope) !== digest(captureBuiltinCurrentScope(captured.scope, fixed))) throw new ReviewError('SCOPE_CHANGED', '检查期间输入、策略、插件或环境发生变化；不能生成可复用回执。')
      const store = builtinStore(fixed, true)
      directory = path.join(store.runsDir, report.run_id)
      fs.mkdirSync(directory, { mode: 0o700 })
      recording.artifacts_path = directory
      for (const [name, bytes] of [['input.json', captured.archiveBytes], ['policy.json', captured.policyBytes], ['normalized.json', JSON.stringify(captured.archive, null, 2) + '\n']]) {
        fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx', mode: 0o600 })
      }
      cancelled(signal)
      if (digest(captured.scope) !== digest(captureBuiltinCurrentScope(captured.scope, fixed))) throw new ReviewError('SCOPE_CHANGED', '记录期间绑定项变化，未发布回执。')
      report.execution.elapsed_ms = performance.now() - started
      // report.json is the immutable judgment core. Post-publication recording
      // metadata is returned separately, avoiding a receipt/report hash cycle.
      fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      writeBuiltinReceipt(directory, report, captured.scope)
      recording.receipt_available = true; recording.eligible_at_recording = report.status === 'PASS'
    } catch (error) {
      report.execution.errors.push({ code: errorCode(error), message: error instanceof ReviewError ? error.message : '本地检查或留痕失败；请核查来源、状态目录与权限。',
        ...(error instanceof ReviewError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) })
      if (report.status !== 'FAIL') { report.status = 'REVIEW'; report.gate_passed = null }
      report.execution.elapsed_ms = performance.now() - started
      if (directory) {
        // Never overwrite a report, receipt, source snapshot, or earlier error.
        try { fs.writeFileSync(path.join(directory, 'recording-error.json'), JSON.stringify({ ...report, recording }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) } catch { /* original failure remains in the returned diagnostic */ }
      }
    }
    return { ...report, recording }
  } }
}

export function renderBuiltinReport(report) {
  const labels = { PASS: '通过', FAIL: '失败', REVIEW: '待复核' }
  return [`独立阈值门禁：${labels[report.status]}（${report.status}）`, `判定器：${report.engine.id}`,
    ...report.metrics.map(metric => `${metric.metric}：${metric.mean ?? '未得到完整均值'} ${metric.unit}；${metric.operator === 'gte' ? '≥' : '≤'} ${metric.threshold}；${labels[metric.status]}；有效 ${metric.valid_count}/${metric.total_count}，缺失 ${metric.missing_count}，非法 ${metric.invalid_count}。`),
    `回执：${report.recording.receipt_available ? '已保存' : '未生成'}；运行编号：${report.run_id}`,
    ...report.execution.errors.map(error => `需核查 [${error.code}]：${error.message}`),
    '检查有效性用 veriscope_gate_status；重新判定用 veriscope_gate_check。', ...report.limitations].join('\n')
}
