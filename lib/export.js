import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ReviewError } from './errors.js'
import { storePaths, validRunId } from './receipt.js'
import { sha256 } from './source.js'
import { readRecord, createStatusService } from './status.js'
import { recordError } from './catalog.js'
import { reasonMessages } from './reasons.js'

const cell = x => String(x ?? '未知').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replaceAll('`', '\\`').replace(/[\r\n]/g, ' ')
function markdown(records) {
  const labels = { PASS: '通过', FAIL: '失败', REVIEW: '待复核', unknown: '未知' }
  return records.map(({ receipt, report, status }) => {
    const p = receipt.payload, primary = report.metrics.find(m => m.primary)
    return [`# 门禁报告`, '', `- 运行编号：${cell(p.run_id)}`, `- 当前状态：${labels[status.current_verdict]}（${status.current_verdict}）`, `- 历史裁决：${labels[p.historical_verdict]}（${p.historical_verdict}）`, `- 检查时间：${cell(status.checked_at_utc)}`, `- 当前原因：${status.reason_messages.map(cell).join('；')}`, `- 输入：${cell(p.scope.input.path)}`, `- 证据条数：${report.evidence.length}`, '', '| 指标 | 归档值 | 本次阈值 |', '|---|---|---|', `| 正向 Faithfulness | ${cell(primary?.pos_faithfulness)} | ${cell(p.scope.thresholds.faith)} |`, `| 正向 Context Precision | ${cell(primary?.pos_context_precision)} | ${cell(p.scope.thresholds.ctx)} |`, '', '## 限制', '', ...[...report.limitations, ...status.limitations].map(s => '- ' + cell(s)), '', '导出不重放、不评分、不生成新回执；当前待复核不会改写历史失败。', ''].join('\n')
  }).join('\n---\n\n')
}
export function createExportService(options = {}) {
  const statuses = options.statusService ?? createStatusService(options)
  return { async export(args, { signal } = {}) {
    const value = { schema_version: 'GateExportV1', status: 'REVIEW', exported: false, path: null, format: args?.format ?? null, run_ids: [], current: [], sha256: null, bytes: null, reason_codes: [], reason_messages: [] }
    let temporary
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['run_id', 'run_ids', 'format'].includes(k)) || Object.hasOwn(args, 'run_id') === Object.hasOwn(args, 'run_ids') || !['md', 'json'].includes(args.format)) throw new ReviewError('INVALID_ARGUMENT', '提供 run_id 或 run_ids，并选择 md 或 json。')
      const ids = Object.hasOwn(args, 'run_id') ? [args.run_id] : args.run_ids
      if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string')) throw new ReviewError('INVALID_ARGUMENT', '每次导出 1–50 个 UUID。')
      value.run_ids = ids.map(validRunId)
      if (new Set(value.run_ids).size !== ids.length) throw new ReviewError('INVALID_ARGUMENT', '不接受重复运行编号。')
      const records = []
      for (const id of value.run_ids) {
        if (signal?.aborted) throw new ReviewError('CANCELLED', '导出已取消。')
        const record = readRecord({ run_id: id }, options), status = await statuses.status({ run_id: id }, { signal })
        if (status.integrity !== 'VALID') throw new ReviewError('RECEIPT_INVALID', '导出时回执或原报告不可验证。')
        const second = readRecord({ run_id: id }, options)
        if (!record.raw.equals(second.raw)) throw new ReviewError('CHECK_RACE', '导出过程中回执变化。')
        records.push({ ...record, status }); value.current.push(status)
      }
      if (signal?.aborted) throw new ReviewError('CANCELLED', '导出已取消。')
      // One JSON export is byte-identical to the original receipt. Multi-export is
      // an array of untouched receipt objects, with no predicted fields inserted.
      const bytes = args.format === 'json' ? records.length === 1 ? records[0].raw : Buffer.from('[\n' + records.map(r => r.raw.toString('utf8').trim()).join(',\n') + '\n]\n') : Buffer.from(markdown(records), 'utf8')
      const { stateRoot } = storePaths(options, true), directory = path.join(stateRoot, 'exports')
      fs.mkdirSync(directory, { recursive: true })
      if (fs.lstatSync(directory).isSymbolicLink() || path.dirname(fs.realpathSync(directory)) !== stateRoot) throw new ReviewError('STATE_PATH_ESCAPE', '导出目录不可重定向。')
      const filename = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.${args.format}`)
      temporary = path.join(directory, `.export-${randomUUID()}.tmp`)
      const handle = fs.openSync(temporary, 'wx', 0o600)
      try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
      if (signal?.aborted) throw new ReviewError('CANCELLED', '导出已取消。')
      fs.linkSync(temporary, filename); fs.unlinkSync(temporary); temporary = null
      value.exported = true; value.status = 'EXPORTED'; value.path = filename; value.sha256 = sha256(bytes); value.bytes = bytes.length
    } catch (error) { value.reason_codes = [recordError(error)] }
    finally { if (temporary) { try { fs.unlinkSync(temporary) } catch {} } }
    value.reason_messages = reasonMessages(value.reason_codes)
    return value
  } }
}
export function renderExport(value) {
  return value.exported ? `报告已导出：${value.path}\n格式：${value.format}；${value.bytes} 字节；SHA-256：${value.sha256}\nJSON 是历史原回执；当前有效性另见本次 current 字段。导出不表示门禁通过。` : `导出未完成：${value.reason_messages.join('；')}。未覆盖旧文件。`
}
