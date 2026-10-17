import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createManagedService, pluginConfiguration } from '../lib/managed.js'
import { receiptFixture } from './fusion-helpers.js'
const execution = (id = 'session-A') => ({ agent: { session: { id } }, signal: new AbortController().signal })

test('completionMode defaults off and rejects unknown/illegal configurations', () => {
  assert.equal(pluginConfiguration().completionMode, 'off')
  assert.equal(pluginConfiguration({ completionMode: 'remind' }).completionMode, 'remind')
  for (const c of [{ completionMode: 'strict' }, { completionMode: false }, { arbitrary: true }, []]) assert.throws(() => pluginConfiguration(c))
})
test('only current PASS bound in same host session can complete once', async t => {
  const f = await receiptFixture(t), m = createManagedService(f.options), args = { task_id: 'task-1', run_id: f.report.run_id }
  assert.equal((await m.complete(args, execution())).accepted, false)
  assert.equal((await m.bind(args, execution())).accepted, true)
  assert.equal((await m.complete(args, execution('session-B'))).accepted, false)
  assert.equal((await m.complete(args, execution())).accepted, true)
  assert.equal((await m.complete(args, execution())).accepted, false)
  assert.equal(fs.readdirSync(path.join(f.root, 'completions')).length, 1)
})
for (const kind of ['fail', 'review']) test(`${kind} can never be marked completed`, async t => {
  const f = await receiptFixture(t, 'fail'), m = createManagedService(f.options), args = { task_id: 'rejected', run_id: f.report.run_id }
  if (kind === 'review') fs.appendFileSync(f.input, ' ')
  await m.bind(args, execution())
  const result = await m.complete(args, execution())
  assert.equal(result.accepted, false)
})
test('model-supplied session_id, policy and arbitrary run substitution are rejected', async t => {
  const f = await receiptFixture(t), m = createManagedService(f.options), args = { task_id: 'scope', run_id: f.report.run_id }
  assert.equal((await m.bind({ ...args, session_id: 'session-A' }, execution())).accepted, false)
  assert.equal((await m.bind(args, {})).accepted, false)
  assert.equal((await m.bind({ ...args, faith: 0.9 }, execution())).accepted, false)
  assert.equal((await m.bind(args, execution())).accepted, true)
  assert.equal((await m.complete({ ...args, faith: 0 }, execution())).accepted, false)
  assert.equal((await m.complete({ ...args, run_id: '01234567-0123-4123-8123-0123456789ab' }, execution())).accepted, false)
})
test('change after binding refuses completion without overwriting original FAIL/PASS', async t => {
  const f = await receiptFixture(t), m = createManagedService(f.options), args = { task_id: 'edit', run_id: f.report.run_id }, original = fs.readFileSync(f.receipt)
  assert.equal((await m.bind(args, execution())).accepted, true)
  fs.appendFileSync(f.input, ' ')
  assert.equal((await m.complete(args, execution())).accepted, false)
  assert.deepEqual(fs.readFileSync(f.receipt), original)
})
test('change between checks rejects completion', async t => {
  const f = await receiptFixture(t)
  let calls = 0
  const m = createManagedService({ ...f.options, statusService: { async status(...args) { calls++; if (calls === 3) fs.appendFileSync(f.input, ' '); return f.status.status(...args) } } })
  const args = { task_id: 'race', run_id: f.report.run_id }
  assert.equal((await m.bind(args, execution())).accepted, true)
  assert.equal((await m.complete(args, execution())).accepted, false)
})
test('completion record write failure is not an accepted completion', async t => {
  const f = await receiptFixture(t), m = createManagedService(f.options), args = { task_id: 'disk', run_id: f.report.run_id }
  await m.bind(args, execution()); fs.writeFileSync(path.join(f.root, 'completions'), 'not a directory')
  const result = await m.complete(args, execution())
  assert.equal(result.accepted, false); assert.equal(result.reason_code, 'COMPLETION_WRITE_FAILED')
})
test('reminder is one per turn/task/scope, is not completion, and dispose removes bindings', async t => {
  const f = await receiptFixture(t), m = createManagedService(f.options), args = { task_id: 'remind', run_id: f.report.run_id }
  await m.bind(args, execution())
  const notices = [], event = { agent: { session: { id: 'session-A' }, steer: text => notices.push(text) }, turn: 1, signal: new AbortController().signal }
  assert.equal(await m.remind(event), true); assert.equal(await m.remind(event), false)
  assert.equal(await m.remind({ ...event, turn: 2 }), false)
  assert.equal(notices.length, 1)
  m.dispose()
  assert.equal(await m.remind({ ...event, turn: 3 }), false)
  assert.equal((await m.complete(args, execution())).accepted, false)
})
test('cancel, restart, parallel completion and duplicate bind cannot accept extra completion', async t => {
  const f = await receiptFixture(t), m = createManagedService(f.options), args = { task_id: 'once', run_id: f.report.run_id }
  assert.equal((await m.bind(args, { ...execution(), signal: AbortSignal.abort() })).accepted, false)
  assert.equal((await m.bind(args, execution())).accepted, true)
  assert.equal((await m.bind(args, execution())).accepted, false)
  assert.equal((await createManagedService(f.options).complete(args, execution())).accepted, false)
  const outcomes = await Promise.all([m.complete(args, execution()), m.complete(args, execution())])
  assert.equal(outcomes.filter(r => r.accepted).length, 1)
})
