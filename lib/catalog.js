import fs from 'node:fs'
import path from 'node:path'
import { ReviewError } from './errors.js'
import { storePaths, locateRun, readBounded, UUID, digest } from './receipt.js'
import { parseLocatedJson } from './source.js'
import { createStatusService } from './status.js'
import { reasonMessage, reasonMessages } from './reasons.js'

export const SCAN_LIMIT = 10_000
export function recordError(error) {
  return error instanceof ReviewError ? error.code : ['ENOENT', 'ENOTDIR'].includes(error?.code) ? 'RECORD_OR_SOURCE_MISSING' : ['EACCES', 'EPERM'].includes(error?.code) ? 'RECORD_PERMISSION' : 'RECORD_INVALID'
}
export function scanRuns(options = {}, signal) {
  const { runsDir } = storePaths(options), rows = []
  let handle, truncated = false
  try { handle = fs.opendirSync(runsDir) } catch (error) { if (error.code === 'ENOENT') return { rows, truncated }; throw error }
  try {
    let entry
    while ((entry = handle.readSync())) {
      if (signal?.aborted) throw new ReviewError('CANCELLED', '扫描已取消。')
      if (rows.length >= SCAN_LIMIT) { truncated = true; break }
      const filename = path.join(runsDir, entry.name)
      const row = { run_id: UUID.test(entry.name) ? entry.name.toLowerCase() : null, entry: entry.name, created_at_utc: null, time_source: 'filesystem_mtime', historical_verdict: 'unknown', input: null, reason_codes: [], sort_time: 0 }
      try {
        row.sort_time = fs.lstatSync(filename).mtimeMs
        if (!entry.isDirectory() || entry.isSymbolicLink() || !row.run_id) throw new ReviewError('RUN_DIRECTORY_INVALID', '运行目录无效。')
        const run = locateRun(options, row.run_id), file = path.join(run.directory, 'receipt.json')
        if (fs.lstatSync(file).isSymbolicLink()) throw new ReviewError('STATE_PATH_ESCAPE', '回执不得重定向。')
        const receipt = parseLocatedJson(new TextDecoder('utf8', { fatal: true }).decode(readBounded(file, 1024 * 1024))).value, p = receipt.payload
        if (receipt.schema_version !== 'ReceiptV1' || !p || p.run_id !== row.run_id || !['PASS', 'FAIL', 'REVIEW'].includes(p.historical_verdict) || digest(p) !== receipt.integrity_sha256 || digest(p.scope) !== p.scope_digest || !p.scope?.input || !Number.isFinite(Date.parse(p.created_at_utc))) throw new ReviewError('RECEIPT_INVALID', '回执结构或摘要无效。')
        row.created_at_utc = p.created_at_utc; row.time_source = 'receipt'; row.sort_time = Date.parse(p.created_at_utc)
        row.historical_verdict = p.historical_verdict; row.input = p.scope.input
      } catch (error) { row.reason_codes = [recordError(error)] }
      rows.push(row)
    }
  } finally { handle.closeSync() }
  rows.sort((a, b) => b.sort_time - a.sort_time || a.entry.localeCompare(b.entry))
  return { rows, truncated }
}
export function createListService(options = {}) {
  const statuses = options.statusService ?? createStatusService(options)
  return { async list(args = {}, { signal } = {}) {
    const result = { schema_version: 'GateListV1', status: 'OK', items: [], damaged: [], scanned: 0, returned: 0, limit: 50, truncated: false, reason_codes: [], reason_messages: [] }
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => k !== 'limit') || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200))) throw new ReviewError('INVALID_ARGUMENT', 'limit 必须为 1–200 的整数。')
      result.limit = args.limit ?? 50
      const scan = scanRuns(options, signal); result.scanned = scan.rows.length; result.truncated = scan.truncated
      result.damaged = scan.rows.filter(r => r.reason_codes.length).map(({ sort_time, ...r }) => ({ ...r, reason_messages: reasonMessages(r.reason_codes) }))
      if (scan.truncated) result.reason_codes.push('SCAN_LIMIT')
      for (const row of scan.rows.slice(0, result.limit)) {
        if (signal?.aborted) throw new ReviewError('CANCELLED', '清单查询已取消。')
        const current = row.run_id && !row.reason_codes.length ? await statuses.status({ run_id: row.run_id }, { signal }) : null
        const { sort_time, ...item } = row
        result.items.push({ ...item, current_verdict: current?.current_verdict ?? 'REVIEW', freshness: current?.freshness ?? 'UNKNOWN', integrity: current?.integrity ?? 'INVALID', reason_codes: current?.reason_codes ?? item.reason_codes, reason_messages: current?.reason_messages ?? reasonMessages(item.reason_codes) })
        if (current && current.integrity !== 'VALID' && !result.damaged.some(r => r.entry === item.entry)) result.damaged.push({ ...item, reason_codes: current.reason_codes, reason_messages: reasonMessages(current.reason_codes) })
      }
      if (result.damaged.length || result.reason_codes.length) result.status = 'REVIEW'
    } catch (error) { result.status = 'REVIEW'; result.reason_codes.push(recordError(error)) }
    result.returned = result.items.length; result.reason_messages = reasonMessages(result.reason_codes)
    return result
  } }
}
export function renderList(value) {
  const labels = { PASS: '通过', FAIL: '失败', REVIEW: '待复核', unknown: '未知' }
  return [`回执清单：返回 ${value.returned} / 扫描 ${value.scanned} 条；损坏或缺失 ${value.damaged.length} 条。`,
    ...value.items.map(r => `${r.run_id ?? r.entry}｜历史：${labels[r.historical_verdict]}｜当前：${labels[r.current_verdict]}｜${r.created_at_utc ?? '时间未知'}｜${r.input?.path ?? '输入未知'}｜${r.reason_messages.join('；')}`),
    ...value.damaged.map(r => `损坏记录 ${r.entry}：${r.reason_messages.join('；')}`), ...value.reason_codes.map(reasonMessage),
    '当前有效性由 status 逐条复验；损坏记录保留。分页范围不代表全部记录均有效。'].join('\n')
}
