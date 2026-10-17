#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { storePaths, UUID, readBounded } from '../lib/receipt.js'

// Inventory only: there is deliberately no unlink/rmdir or executable deletion plan.
export function previewRetention(env = process.env, { entryLimit = 10_000 } = {}) {
  if (!Number.isSafeInteger(entryLimit) || entryLimit < 1 || entryLimit > 100_000) throw new Error('清单上限无效。')
  const { stateRoot } = storePaths({ env, requireExplicitStateDir: true })
  const value = { schema_version: 'RetentionPreviewV1', mode: 'dry_run', deletion_supported: false,
    retention: 'indefinite', state_root: stateRoot, exists: fs.existsSync(stateRoot), files: 0,
    bytes: 0, entries: 0, truncated: false, skipped_links: [], unreadable: [], runs: [],
    exports: [], completions: [], unclassified: [], limitations: [
      '所有记录默认无限期保留；本命令只读，不提供删除入口。',
      '容量按目录项的逻辑字节数统计，不是磁盘实际占用；硬链接可能重复计数。',
      '关联来自记录字段，未进行回执有效性或语义核验；未知关联保持未知。',
    ] }
  if (!value.exists) return value
  if (fs.lstatSync(stateRoot).isSymbolicLink()) throw new Error('状态根不得为符号链接。')
  const buckets = new Map(), queue = [stateRoot]
  while (queue.length && !value.truncated) {
    const directory = queue.pop()
    let entries
    try { entries = fs.opendirSync(directory) } catch { value.unreadable.push(path.relative(stateRoot, directory)); continue }
    try {
      let entry
      while ((entry = entries.readSync())) {
        if (++value.entries > entryLimit) { value.truncated = true; break }
        const filename = path.join(directory, entry.name), relative = path.relative(stateRoot, filename)
        try {
          const stat = fs.lstatSync(filename)
          if (stat.isSymbolicLink()) { value.skipped_links.push(relative); continue }
          if (stat.isDirectory()) { queue.push(filename); continue }
          if (!stat.isFile()) { value.unclassified.push(relative); continue }
          value.files++; value.bytes += stat.size
          const parts = relative.split(path.sep)
          if (parts[0] === 'runs' && parts.length === 3 && UUID.test(parts[1])) {
            if (!buckets.has(parts[1])) buckets.set(parts[1], { run_id: parts[1], bytes: 0, files: [], historical_verdict: 'unknown', association_verified: false })
            const run = buckets.get(parts[1]); run.bytes += stat.size; run.files.push(parts[2])
            if (parts[2] === 'receipt.json' && stat.size <= 1024 * 1024) {
              try { const receipt = JSON.parse(readBounded(filename, 1024 * 1024)); if (['ReceiptV1', 'ReceiptV2'].includes(receipt.schema_version) && receipt.payload?.run_id === run.run_id && ['PASS', 'FAIL', 'REVIEW'].includes(receipt.payload.historical_verdict)) { run.historical_verdict = receipt.payload.historical_verdict; if (receipt.schema_version === 'ReceiptV2') run.engine = receipt.payload.engine } } catch { /* damaged records remain visible */ }
            }
          } else if (parts[0] === 'exports' || parts[0] === 'completions') {
            const row = { path: relative, bytes: stat.size, run_ids: [], association: 'unknown' }
            if (path.extname(filename) === '.json' && stat.size <= 1024 * 1024) {
              try {
                const data = JSON.parse(readBounded(filename, 1024 * 1024)), records = Array.isArray(data) ? data : [data]
                for (const record of records) {
                  const id = ['ReceiptV1', 'ReceiptV2'].includes(record?.schema_version) ? record.payload?.run_id : record?.schema_version === 'ManagedCompletionV1' ? record.run_id : null
                  if (typeof id === 'string' && UUID.test(id)) row.run_ids.push(id)
                }
                row.run_ids = [...new Set(row.run_ids)]
                if (row.run_ids.length) row.association = 'recorded_unverified'
              } catch { /* no inferred relationship from damaged content */ }
            }
            value[parts[0]].push(row)
          } else value.unclassified.push(relative)
        } catch { value.unreadable.push(relative) }
      }
    } finally { entries.closeSync() }
  }
  value.runs = [...buckets.values()].sort((a, b) => a.run_id.localeCompare(b.run_id))
  return value
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, json: { type: 'boolean' } }, strict: true, allowPositionals: false })
    if (positionals.length) throw new Error('不接受位置参数。')
    const result = previewRetention()
    console.log(values.json ? JSON.stringify(result, null, 2) : [
      '状态留存预演（只读，不删除）', `状态根：${result.state_root}`,
      `文件 ${result.files} 个，逻辑字节 ${result.bytes}；运行记录 ${result.runs.length} 个。`,
      `清单${result.truncated ? '已截断' : '未截断'}；跳过链接 ${result.skipped_links.length} 个；不可读 ${result.unreadable.length} 项。`,
      ...result.limitations,
    ].join('\n'))
    if (result.truncated || result.unreadable.length) process.exitCode = 2
  } catch (error) { console.error('无法预演：' + error.message); process.exitCode = 2 }
}
