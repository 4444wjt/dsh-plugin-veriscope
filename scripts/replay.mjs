import { parseArgs } from 'node:util'
import { createReplayService, renderReport } from '../lib/replay.js'
try {
  const { values } = parseArgs({ options: { result: { type: 'string' }, baseline: { type: 'string' }, faith: { type: 'string' }, ctx: { type: 'string' }, json: { type: 'boolean' } }, strict: true })
  const args = { result_path: values.result }
  if (values.baseline !== undefined) args.baseline = values.baseline
  for (const key of ['faith', 'ctx']) if (values[key] !== undefined) args[key] = values[key].trim() ? Number(values[key]) : NaN
  const report = await createReplayService().replay(args)
  console.log(values.json ? JSON.stringify(report, null, 2) : renderReport(report))
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2
} catch {
  console.error('参数无效。用法：node scripts/replay.mjs --result <归档.json> [--baseline <基线.json>] [--faith 0.8] [--ctx 0.8] [--json]')
  process.exitCode = 2
}
