import fs from 'node:fs'
import path from 'node:path'
import { resolveConfiguration, validateArguments } from './config.js'
import { ReviewError } from './errors.js'
import { createReplayService } from './replay.js'
import { reasonMessages, renderReasons } from './reasons.js'

export function createBatchService(options = {}) {
  const replay = options.replayService ?? createReplayService(options)
  return { async batch(args, { signal, sessionId } = {}) {
    const value = { schema_version: 'GateBatchV1', status: 'REVIEW', gate_passed: null, counts: { pass: 0, fail: 0, review: 0, error: 0 }, items: [], requested: 0, processed: 0, cancelled: false, reason_codes: [], reason_messages: [], new_evaluation_model_calls: 0 }
    try {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['paths', 'dir', 'faith', 'ctx', 'baseline'].includes(k)) || Object.hasOwn(args, 'paths') === Object.hasOwn(args, 'dir')) throw new ReviewError('INVALID_ARGUMENT', 'paths 与 dir 必须且只能提供一个。')
      const config = resolveConfiguration(options.env ?? process.env)
      // This validates policy only; it never recomputes a metric or changes thresholds.
      const policy = Object.fromEntries(['faith', 'ctx', 'baseline'].filter(k => Object.hasOwn(args, k)).map(k => [k, args[k]]))
      validateArguments({ result_path: '.', ...policy }, config.veriscopeRoot)
      let paths
      if (Object.hasOwn(args, 'paths')) {
        if (!Array.isArray(args.paths) || !args.paths.length || args.paths.some(p => typeof p !== 'string' || !p.trim() || p.includes('\0'))) throw new ReviewError('INVALID_ARGUMENT', 'paths 必须是非空路径数组。')
        paths = [...args.paths]
      } else {
        if (typeof args.dir !== 'string' || !args.dir.trim() || args.dir.includes('\0')) throw new ReviewError('INVALID_ARGUMENT', 'dir 必须是非空目录路径。')
        const directory = path.resolve(config.veriscopeRoot, args.dir)
        if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) throw new ReviewError('BATCH_DIRECTORY_INVALID', '目录类型无效。')
        paths = []
        const handle = fs.opendirSync(directory)
        try {
          let entry, count = 0
          while ((entry = handle.readSync())) {
            if (++count > 10_000) throw new ReviewError('SCAN_LIMIT', '目录超出扫描上限。')
            if (signal?.aborted) throw new ReviewError('CANCELLED', '操作已取消。')
            if (/\.json$/i.test(entry.name)) paths.push(path.join(directory, entry.name))
            if (paths.length > 200) throw new ReviewError('BATCH_LIMIT', '批量上限为 200 份。')
          }
        } finally { handle.closeSync() }
        paths.sort((a, b) => a.localeCompare(b, 'en'))
        if (!paths.length) throw new ReviewError('INVALID_ARGUMENT', '目录内没有 JSON 文件；不递归读取子目录。')
      }
      value.requested = paths.length
      if (paths.length > 200) throw new ReviewError('BATCH_LIMIT', '批量上限为 200 份。')
      for (const filename of paths) {
        if (signal?.aborted) { value.cancelled = true; value.reason_codes.push('CANCELLED'); break }
        let report, codes = []
        try { report = await replay.replay({ result_path: filename, ...policy }, { signal, sessionId }) }
        catch { codes = ['EXECUTION_ERROR'] }
        const verdict = ['PASS', 'FAIL', 'REVIEW'].includes(report?.status) ? report.status : 'REVIEW'
        codes.push(...(report?.execution?.errors ?? []).map(e => e.code))
        // Error is an operational classification, separate from a confirmed quality FAIL.
        const error = !report || (verdict === 'REVIEW' && (!report.execution?.command || report.execution?.process?.reason || report.execution?.process?.error || report.execution?.process?.signal))
        const bucket = verdict === 'FAIL' ? 'fail' : verdict === 'PASS' ? 'pass' : error ? 'error' : 'review'
        value.counts[bucket]++
        value.items.push({ path: filename, run_id: report?.run_id ?? null, status: verdict, outcome: bucket, reason_codes: codes, reason_messages: reasonMessages(codes), artifacts_path: report?.execution?.artifacts_path ?? null })
      }
    } catch (error) { value.reason_codes.push(error.code ?? 'EXECUTION_ERROR'); if (error.code === 'CANCELLED') value.cancelled = true }
    if (signal?.aborted) { value.cancelled = true; if (!value.reason_codes.includes('CANCELLED')) value.reason_codes.push('CANCELLED') }
    value.processed = value.items.length; value.reason_messages = reasonMessages(value.reason_codes)
    value.status = value.counts.fail ? 'FAIL' : value.reason_codes.length || value.cancelled || !value.processed || value.counts.review || value.counts.error ? 'REVIEW' : 'PASS'
    value.gate_passed = value.status === 'PASS' ? true : value.status === 'FAIL' ? false : null
    return value
  } }
}
export function renderBatch(value) {
  const labels = { PASS: '通过', FAIL: '失败', REVIEW: '待复核' }
  return [`批量门禁：${labels[value.status]}（${value.status}）`, `通过 ${value.counts.pass}／失败 ${value.counts.fail}／待复核 ${value.counts.review}／错误 ${value.counts.error}；已处理 ${value.processed}/${value.requested}。`,
    ...value.items.map(i => `${i.path}：${labels[i.status]}${i.outcome === 'error' ? '（执行错误）' : ''}｜${i.run_id ?? '无运行编号'}｜${renderReasons(i.reason_codes) || '未记录异常'}`),
    renderReasons(value.reason_codes), '已确认 FAIL 优先保留；错误和未处理项不会被算作通过。各份仍以 Python 重放裁决为准。'].filter(Boolean).join('\n')
}
