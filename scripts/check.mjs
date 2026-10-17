#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createBuiltinService, renderBuiltinReport } from '../lib/builtin.js'

export async function runCheck(argv = process.argv.slice(2), env = process.env) {
  try {
    const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
      archive: { type: 'string' }, policy: { type: 'string' }, format: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
    } })
    if (values.help) return { code: 0, text: '用法：veriscope-check --archive <评分.json> --policy <策略.json> [--format gate-archive-v1|ragas-records-v1] [--json]\n必须显式设置 VERISCOPE_STATE_DIR；不读取 .env，不评分或调用模型。' }
    const value = await createBuiltinService({ env }).check({
      archive_path: values.archive?.trim() ? path.resolve(values.archive) : '', policy_path: values.policy?.trim() ? path.resolve(values.policy) : '',
      ...(values.format !== undefined ? { format: values.format } : {}),
    })
    return { code: value.status === 'FAIL' ? 1 : value.status === 'PASS' ? 0 : 2, text: values.json ? JSON.stringify(value, null, 2) : renderBuiltinReport(value), value }
  } catch {
    const value = { schema_version: 'BuiltinCliErrorV1', status: 'REVIEW', gate_passed: null, reason_codes: ['INVALID_ARGUMENT'], message: '命令参数无效；使用 --help 查看格式。未执行判定或生成回执。' }
    return { code: 2, text: argv.includes('--json') ? JSON.stringify(value, null, 2) : value.message, value }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runCheck()
  process.stdout.write(result.text + '\n'); process.exitCode = result.code
}
