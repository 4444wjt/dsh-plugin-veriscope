import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runBoundedProcess } from '../lib/process.js'

test('real local child process returns exact exit and stdout; arguments never go through shell', async () => {
  const value = '路径 含空格 & $(echo unsafe)'
  const result = await runBoundedProcess(process.execPath, ['-e', 'console.log(process.argv[1]);process.exitCode=1', value])
  assert.equal(result.code, 1)
  assert.equal(result.stdout.trim(), value)
  assert.equal(result.reason, null)
})
test('real child timeout terminates without being quality PASS', async () => {
  const result = await runBoundedProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 30 })
  assert.equal(result.reason, 'timeout')
})
test('real cancellation reaches the child', async () => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 50)
  const result = await runBoundedProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal: controller.signal })
  clearTimeout(timer)
  assert.equal(result.reason, 'cancelled')
})
for (const stream of ['stdout', 'stderr']) test(`${stream} limit is independent and bounded`, async () => {
  const result = await runBoundedProcess(process.execPath, ['-e', `process.${stream}.write('a'.repeat(5000))`], { outputBytes: 128 })
  assert.equal(result.reason, 'output_limit')
  assert.ok(Buffer.byteLength(result[stream]) <= 128)
})
test('missing executable and pre-aborted request are recorded', async () => {
  const result = await runBoundedProcess('Z:/not-an-executable/python.exe', [])
  assert.equal(result.reason, 'spawn_error')
  assert.equal((await runBoundedProcess(process.execPath, ['-e', 'throw Error()'], { signal: AbortSignal.abort() })).reason, 'cancelled')
})
