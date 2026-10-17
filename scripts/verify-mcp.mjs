// Source-only real-Python verification. No model, SDK, or host conversation is used.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
export function verdictProjection(report) {
  return { status: report.status, gate_passed: report.gate_passed, exit_code: report.exit_code,
    thresholds: report.thresholds, metrics: report.metrics, archived_gate: report.archived_gate,
    judge_provenance: report.judge_provenance,
    evidence: report.evidence.filter(item => item.kind === 'archive_field').map(({ kind, sha256, locator, quote }) => ({ kind, sha256, locator, quote })),
    input_sha256: report.evidence.find(item => item.kind === 'archive_field')?.sha256 ?? null,
    upstream_files: report.execution.script_files,
    errors: report.execution.errors.map(({ code, diagnostic, diagnostic_source }) => ({ code, ...(diagnostic ? { diagnostic, diagnostic_source } : {}) })),
  }
}

export async function verifyMcp(env = process.env) {
  assert.ok(env.VERISCOPE_STATE_DIR && path.isAbsolute(env.VERISCOPE_STATE_DIR), '请显式设置独立状态根。')
  const output = env.VERISCOPE_VERIFICATION_OUTPUT ?? path.join(env.VERISCOPE_STATE_DIR, 'verification')
  fs.mkdirSync(output, { recursive: true })
  const childEnv = { ...env, PYTHONDONTWRITEBYTECODE: '1', PYTHON_DOTENV_DISABLED: '1' }
  for (const key of Object.keys(childEnv)) if (/API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) delete childEnv[key]
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp.js')], { cwd: ROOT, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let nextId = 1, buffer = '', diagnostics = '', closed = false
  const pending = new Map()
  child.stderr.on('data', chunk => { if (diagnostics.length < 524288) diagnostics += chunk.toString('utf8') })
  const rejectPending = error => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error) }; pending.clear() }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', text => {
    buffer += text
    if (buffer.length > 64 * 1024 * 1024) { rejectPending(new Error('协议响应超过验证上限。')); child.kill(); return }
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
      try {
        const message = JSON.parse(line), item = pending.get(message.id)
        assert.equal(message.jsonrpc, '2.0')
        if (!item) continue
        clearTimeout(item.timer); pending.delete(message.id)
        if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result)
      } catch (error) { rejectPending(error) }
    }
  })
  child.on('error', rejectPending)
  const exited = new Promise(resolve => child.on('close', (code, signal) => { closed = true; rejectPending(new Error(`MCP 进程结束 ${code}/${signal}`)); resolve({ code, signal }) }))
  function request(method, params) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`请求超时：${method}`)) }, 180_000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n')
    })
  }
  const records = []
  try {
    const initialization = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'veriscope-real-python-verification', version: '0.4.0' } })
    assert.equal(initialization.protocolVersion, '2025-11-25')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const listing = await request('tools/list', {})
    assert.deepEqual(listing.tools.map(tool => tool.name).sort(), ['veriscope_doctor', 'veriscope_gate_replay', 'veriscope_gate_status', 'veriscope_gate_list'].sort())
    const doctor = await request('tools/call', { name: 'veriscope_doctor', arguments: {} })
    assert.equal(doctor.structuredContent.status, 'READY', JSON.stringify(doctor.structuredContent))
    const cases = [ ['boundary', path.join(ROOT, 'tests/fixtures/boundary.json'), 'PASS', 'constructed'],
      ['below-boundary', path.join(ROOT, 'tests/fixtures/below-boundary.json'), 'FAIL', 'constructed'],
      ['broken', path.join(ROOT, 'tests/fixtures/batch-broken.json'), 'REVIEW', 'constructed_invalid'] ]
    if (env.VERISCOPE_ACCEPTANCE_HISTORICAL) cases.push(['historical-fail', env.VERISCOPE_ACCEPTANCE_HISTORICAL, 'FAIL', 'historical_archive'])
    for (const [name, filename, expected, provenance] of cases) {
      const call = await request('tools/call', { name: 'veriscope_gate_replay', arguments: { result_path: filename } })
      const report = call.structuredContent
      assert.equal(report.status, expected, JSON.stringify(report.execution?.errors))
      assert.equal(report.execution.session_id, null)
      assert.equal(report.execution.new_evaluation_model_calls, 0)
      if (expected !== 'REVIEW') assert.equal(Boolean(call.isError), false)
      const status = await request('tools/call', { name: 'veriscope_gate_status', arguments: { run_id: report.run_id } })
      assert.equal(status.structuredContent.current_verdict, expected)
      records.push({ name, provenance, expected, isError: Boolean(call.isError), projection: verdictProjection(report), report, current: status.structuredContent })
    }
    const recent = await request('tools/call', { name: 'veriscope_gate_list', arguments: { limit: 20 } })
    assert.ok(recent.structuredContent.returned >= cases.length)
    const result = { passed: true, version: '0.4.0', node: process.version, verification_type: 'stdio_client_with_real_python_not_host_acceptance',
      tools: listing.tools.map(({ name, annotations }) => ({ name, annotations })), protocol_version: initialization.protocolVersion,
      three_states: records.slice(0, 3).map(record => record.report.status), records,
      new_evaluation_model_calls: 0, conversation_model_calls: 0 }
    fs.writeFileSync(path.join(output, 'mcp-real-python.json'), JSON.stringify(result, null, 2) + '\n')
    return result
  } finally {
    if (!closed) child.stdin.end()
    const outcome = await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(() => resolve(null), 5000); timer.unref() })])
    if (!outcome) { child.kill(); await exited }
    fs.writeFileSync(path.join(output, 'mcp-stderr.txt'), diagnostics)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await verifyMcp(); console.log(JSON.stringify({ passed: result.passed, cases: result.records.length, states: result.three_states, verification_type: result.verification_type })) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
