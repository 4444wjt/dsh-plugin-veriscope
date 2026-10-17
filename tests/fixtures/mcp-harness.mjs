// Deliberately injected test services, never a replacement for host acceptance.
import { createMcpServer } from '../../lib/mcp.js'
import { runBoundedProcess } from '../../lib/process.js'

const events = []
let active = 0, maximum = 0
const result = (name, extra = {}) => ({ schema_version: 'McpHarnessV1', name, events: [...events], maximum, ...extra })
const wait = (milliseconds, signal) => new Promise(resolve => {
  if (signal.aborted) { resolve(); return }
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, milliseconds)
  signal.addEventListener('abort', done, { once: true })
})
const tools = ['veriscope_gate_replay', 'veriscope_doctor', 'veriscope_gate_status', 'veriscope_gate_list'].map(name => ({
  name, description: '协议测试假服务', outputSchema: { type: 'object' },
  inputSchema: { type: 'object', properties: name === 'veriscope_gate_replay' ? {
    result_path: { type: 'string', minLength: 1 }, faith: { type: 'number', minimum: 0, maximum: 1 },
  } : {}, ...(name === 'veriscope_gate_replay' ? { required: ['result_path'] } : {}), additionalProperties: false },
  annotations: { readOnlyHint: ['veriscope_gate_list', 'veriscope_gate_status'].includes(name) },
  render: () => '协议测试结果',
  async call(args, { signal, sessionId }) {
    if (sessionId !== undefined) throw new Error('An MCP session must not be synthesized')
    if (name === 'veriscope_gate_replay' || name === 'veriscope_doctor') {
      active++; maximum = Math.max(maximum, active); events.push(`${name}:start`)
      if (args.result_path === 'child') {
        const output = await runBoundedProcess(process.execPath, ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'], { signal })
        events.push(`child:${output.stdout.trim()}:${output.reason}`)
      } else await wait(args.result_path === 'slow' ? 500 : 80, signal)
      events.push(`${name}:${signal.aborted ? 'cancelled' : 'done'}`); active--
    }
    if (args.result_path === 'throw') throw new Error(`do not leak ${process.env.TEST_SECRET}`)
    return result(name, name === 'veriscope_gate_replay' ? {
      status: args.result_path === 'review' ? 'REVIEW' : 'FAIL', gate_passed: args.result_path === 'review' ? null : false,
      execution: { session_id: null, errors: args.result_path === 'review' ? [{ code: 'MISSING_POSITIVE_METRICS' }]
        : args.result_path === 'fail-write-error' ? [{ code: 'ARTIFACT_WRITE_ERROR' }] : [] },
    } : name === 'veriscope_doctor' ? { items: [{ status: 'ok' }] } : {})
  },
}))
const server = createMcpServer({ catalog: { tools, dispose() { process.stderr.write(JSON.stringify({ events, maximum }) + '\n') } } })
const stop = () => { void server.close() }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
await server.closed
process.off('SIGINT', stop); process.off('SIGTERM', stop)
