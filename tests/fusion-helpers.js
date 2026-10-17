import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { setup } from './helpers.js'
import { createReplayService } from '../lib/replay.js'
import { createStatusService } from '../lib/status.js'
export async function receiptFixture(t, kind = 'pass', extra = {}) {
  const f = setup(t, { kind }), python = path.join(f.root, 'python-protocol-stub.bin')
  fs.writeFileSync(python, 'protocol mock; no real interpreter')
  f.options.env.VERISCOPE_PYTHON = python
  Object.assign(f.options, extra)
  const report = await createReplayService(f.options).replay({ result_path: f.input })
  const receipt = path.join(report.execution.artifacts_path, 'receipt.json')
  assert.ok(fs.existsSync(receipt), JSON.stringify(report.execution.errors))
  return { ...f, report, receipt, status: createStatusService(f.options), request: { run_id: report.run_id } }
}
