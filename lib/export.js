import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ReviewError } from './errors.js'
import { storePaths, validRunId } from './receipt.js'
import { sha256 } from './source.js'
import { readRecord, createStatusService } from './status.js'
import { recordError } from './catalog.js'
import { REASONS, reasonMessages } from './reasons.js'

const cell = x => String(x ?? '未知').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replaceAll('`', '\\`').replace(/[\r\n]/g, ' ')
function markdown(records) {
  const labels = { PASS: '通过', FAIL: '失败', REVIEW: '待复核', unknown: '未知' }
  return records.map(({ receipt, report, status }) => {
    const p = receipt.payload, primary = report.metrics.find(m => m.primary)
    return [`# 门禁报告`, '', `- 运行编号：${cell(p.run_id)}`, `- 当前状态：${labels[status.current_verdict]}（${status.current_verdict}）`, `- 历史裁决：${labels[p.historical_verdict]}（${p.historical_verdict}）`, `- 检查时间：${cell(status.checked_at_utc)}`, `- 当前原因：${status.reason_messages.map(cell).join('；')}`, `- 输入：${cell(p.scope.input.path)}`, `- 证据条数：${report.evidence.length}`, '', '| 指标 | 归档值 | 本次阈值 |', '|---|---|---|', `| 正向 Faithfulness | ${cell(primary?.pos_faithfulness)} | ${cell(p.scope.thresholds.faith)} |`, `| 正向 Context Precision | ${cell(primary?.pos_context_precision)} | ${cell(p.scope.thresholds.ctx)} |`, '', '## 限制', '', ...[...report.limitations, ...status.limitations].map(s => '- ' + cell(s)), '', '导出不重放、不评分、不生成新回执；当前待复核不会改写历史失败。', ''].join('\n')
  }).join('\n---\n\n')
}

// Sharing uses an explicit projection, never recursive redaction of an original
// receipt. Unknown fields and free text must not become shareable by default.
const SHARE_LABELS = Object.freeze({ PASS: '通过', FAIL: '失败', REVIEW: '待复核' })
const boundedMetric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
const boundedCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null
function shareVersion(value, allowV = false) {
  if (typeof value !== 'string' || value.length > 24) return null
  const pattern = allowV ? /^v?(?:0|[1-9]\d{0,3})(?:\.(?:0|[1-9]\d{0,3})){2}$/ : /^(?:0|[1-9]\d{0,3})(?:\.(?:0|[1-9]\d{0,3})){2}$/
  // JavaScript's $ also matches before a final newline; require exact length.
  return pattern.exec(value)?.[0] === value ? value : null
}
function shareReasons(codes) {
  const known = new Set()
  for (const code of Array.isArray(codes) ? codes : [null]) known.add(typeof code === 'string' && Object.hasOwn(REASONS, code) ? code : null)
  if (!known.size) known.add(null)
  return [...known].map(code => ({ code, message: code === null ? '未知' : REASONS[code] }))
}
function shareProjection(records) {
  return {
    schema_version: 'GateShareSummaryV1', is_receipt: false, can_authorize_completion: false,
    records: records.map(({ receipt, report, status }, index) => {
      const p = receipt.payload
      const primary = Array.isArray(report.metrics) ? report.metrics.find(item => item && item.primary === true) : null
      const current = status.freshness === 'FRESH' && status.integrity === 'VALID' &&
        ((status.current_verdict === 'PASS' && status.gate_passed === true) || (status.current_verdict === 'FAIL' && status.gate_passed === false)) ? status.current_verdict : 'REVIEW'
      return {
        record: `记录${index + 1}`, current_verdict: current, historical_verdict: p.historical_verdict,
        reasons: shareReasons(status.reason_codes),
        thresholds: { faith: boundedMetric(p.scope.thresholds.faith), ctx: boundedMetric(p.scope.thresholds.ctx) },
        metrics: { pos_faithfulness: boundedMetric(primary?.pos_faithfulness), pos_context_precision: boundedMetric(primary?.pos_context_precision) },
        evidence_count: Array.isArray(report.evidence) ? boundedCount(report.evidence.length) : null,
        environment: { node: shareVersion(p.scope.environment.node, true), python: shareVersion(p.scope.environment.python?.version), pandas: shareVersion(p.scope.environment.pandas?.version) },
      }
    }),
  }
}
function shareMarkdown(summary) {
  const display = value => value === null ? '未知' : String(value)
  return ['# 门禁求助摘要', '', '这是一份白名单分享摘要，不是回执，不能用于 bind/complete 或登记任务完成。',
    '只包含固定状态、原因、指标、阈值、计数与严格版本号；未包含路径、原文、日志或完整环境。',
    '统计值和版本信息也可能敏感，请审阅文件正文后再自行分享；插件不会上传。', '',
    ...summary.records.flatMap(record => [
      `## ${record.record}`, '', `- 当前状态：${SHARE_LABELS[record.current_verdict]}（${record.current_verdict}）`,
      `- 历史裁决：${SHARE_LABELS[record.historical_verdict]}（${record.historical_verdict}）`,
      `- 当前原因：${record.reasons.map(reason => reason.message + (reason.code === null ? '' : ` [${reason.code}]`)).join('；')}`,
      `- 证据条数：${display(record.evidence_count)}`, '', '| 指标 | 归档值 | 回执阈值 |', '|---|---|---|',
      `| 正向 Faithfulness | ${display(record.metrics.pos_faithfulness)} | ${display(record.thresholds.faith)} |`,
      `| 正向 Context Precision | ${display(record.metrics.pos_context_precision)} | ${display(record.thresholds.ctx)} |`, '',
      `回执绑定版本：Node ${display(record.environment.node)}；Python ${display(record.environment.python)}；pandas ${display(record.environment.pandas)}。`, '',
    ]), '当前待复核不会改写历史失败；摘要不证明回答事实正确，也不替代原始依据。', ''].join('\n')
}
export function createExportService(options = {}) {
  const statuses = options.statusService ?? createStatusService(options)
  return { async export(args, { signal } = {}) {
    const value = { schema_version: 'GateExportV1', status: 'REVIEW', exported: false, path: null, format: args?.format ?? null, run_ids: [], current: [], sha256: null, bytes: null, reason_codes: [], reason_messages: [] }
    let temporary
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['run_id', 'run_ids', 'format'].includes(k)) || Object.hasOwn(args, 'run_id') === Object.hasOwn(args, 'run_ids') || !['md', 'json', 'share'].includes(args.format)) throw new ReviewError('INVALID_ARGUMENT', '提供 run_id 或 run_ids，并选择 md、json 或 share。')
      const ids = Object.hasOwn(args, 'run_id') ? [args.run_id] : args.run_ids
      if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string')) throw new ReviewError('INVALID_ARGUMENT', '每次导出 1–50 个 UUID。')
      const runIds = ids.map(validRunId)
      if (args.format !== 'share') value.run_ids = runIds
      if (new Set(runIds).size !== ids.length) throw new ReviewError('INVALID_ARGUMENT', '不接受重复运行编号。')
      const records = []
      for (const id of runIds) {
        if (signal?.aborted) throw new ReviewError('CANCELLED', '导出已取消。')
        const record = readRecord({ run_id: id }, options), status = await statuses.status({ run_id: id }, { signal })
        if (status.integrity !== 'VALID') throw new ReviewError('RECEIPT_INVALID', '导出时回执或原报告不可验证。')
        const second = readRecord({ run_id: id }, options)
        if (!record.raw.equals(second.raw)) throw new ReviewError('CHECK_RACE', '导出过程中回执变化。')
        records.push({ ...record, status }); if (args.format !== 'share') value.current.push(status)
      }
      if (signal?.aborted) throw new ReviewError('CANCELLED', '导出已取消。')
      // One JSON export is byte-identical to the original receipt. Multi-export is
      // an array of untouched receipt objects, with no predicted fields inserted.
      const shareSummary = args.format === 'share' ? shareProjection(records) : null
      const bytes = args.format === 'json' ? records.length === 1 ? records[0].raw : Buffer.from('[\n' + records.map(r => r.raw.toString('utf8').trim()).join(',\n') + '\n]\n') : Buffer.from(shareSummary ? shareMarkdown(shareSummary) : markdown(records), 'utf8')
      const { stateRoot } = storePaths(options, true), directory = path.join(stateRoot, 'exports')
      fs.mkdirSync(directory, { recursive: true })
      if (fs.lstatSync(directory).isSymbolicLink() || path.dirname(fs.realpathSync(directory)) !== stateRoot) throw new ReviewError('STATE_PATH_ESCAPE', '导出目录不可重定向。')
      const filename = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.${args.format === 'share' ? 'md' : args.format}`)
      temporary = path.join(directory, `.export-${randomUUID()}.tmp`)
      const handle = fs.openSync(temporary, 'wx', 0o600)
      try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
      if (signal?.aborted) throw new ReviewError('CANCELLED', '导出已取消。')
      fs.linkSync(temporary, filename); fs.unlinkSync(temporary); temporary = null
      value.exported = true; value.status = 'EXPORTED'; value.path = filename; value.sha256 = args.format === 'share' ? null : sha256(bytes); value.bytes = bytes.length
      if (shareSummary) value.share_summary = shareSummary
    } catch (error) {
      const code = recordError(error)
      value.reason_codes = [args?.format !== 'share' || typeof code === 'string' && Object.hasOwn(REASONS, code) ? code : 'UNKNOWN_REASON']
    }
    finally { if (temporary) { try { fs.unlinkSync(temporary) } catch {} } }
    value.reason_messages = args?.format === 'share' ? value.reason_codes.map(code => Object.hasOwn(REASONS, code) ? REASONS[code] : '未知') : reasonMessages(value.reason_codes)
    return value
  } }
}
export function renderExport(value) {
  if (value.exported && value.format === 'share') return `${shareMarkdown(value.share_summary)}\n本地审阅文件：${value.path}\n请分享文件正文或 share_summary；整个工具返回含本地文件位置。`
  return value.exported ? `报告已导出：${value.path}\n格式：${value.format}；${value.bytes} 字节；SHA-256：${value.sha256}\nJSON 是历史原回执；当前有效性另见本次 current 字段。导出不表示门禁通过。` : `导出未完成：${value.reason_messages.join('；')}。未覆盖旧文件。`
}
