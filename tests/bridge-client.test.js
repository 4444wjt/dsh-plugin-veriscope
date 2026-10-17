import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import http from 'node:http'
import { registerStatusBridge } from '../lib/bridge.js'

test('native client registers exactly four result slots and disposes them', () => {
  let plugin
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load({ id, factory }) { assert.equal(id, 'dsh-plugin-veriscope'); plugin = factory(name => { assert.equal(name, 'react'); return { createElement() {} } }) } } } })
  const registered = new Map()
  const dispose = plugin.apply({ slots: {
    register({ name, key }, component) { assert.equal(name, 'tool.call.toolview'); assert.equal(typeof component, 'function'); registered.set(key, component); return () => registered.delete(key) },
    inject(_name, factory) { const ds = [...factory()]; return () => ds.reverse().forEach(d => d()) },
  } })
  assert.equal(registered.size, 4); dispose(); assert.equal(registered.size, 0)
})
test('bridge is optional and text-only host needs no webServer', () => {
  assert.equal(typeof registerStatusBridge({ get: () => undefined }, {}, new Map()), 'function')
})
test('real HTTP status bridge rejects cross-origin, unknown run, non-JSON, extra path and oversized input', async t => {
  const run = '01234567-0123-4123-8123-0123456789ab'
  let route, calls = 0
  const service = { async status(args) { calls++; return { schema_version: 'GateStatusV1', run_id: args.run_id, current_verdict: 'REVIEW', gate_passed: null } } }
  const webServer = { protocol: 'http:', register(value) { route = value; return () => { route = null } } }
  const dispose = registerStatusBridge({ get: () => webServer }, service, new Map([['session-A', new Set([run])]]))
  const server = http.createServer((req, res) => route.handler(req, res))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}`
  const call = (value, headers = {}, method = 'POST') => fetch(url + '/veriscope/status', { method, headers: { Origin: url, 'Content-Type': 'application/json', ...headers }, ...(method !== 'GET' ? { body: typeof value === 'string' ? value : JSON.stringify(value) } : {}) })
  assert.equal((await call({ run_id: run, session_id: 'session-A' })).status, 200)
  assert.equal((await call({}, {}, 'GET')).status, 405)
  assert.equal((await call({ run_id: run, session_id: 'session-A' }, { Origin: 'https://other.example' })).status, 403)
  assert.equal((await call({ run_id: run, session_id: 'session-B' })).status, 403)
  assert.equal((await call({ run_id: run, session_id: 'session-A', path: 'D:/file' })).status, 403)
  assert.equal((await call({}, { 'Content-Type': 'text/plain' })).status, 403)
  assert.equal((await call('x'.repeat(5000))).status, 413)
  assert.equal(calls, 1); dispose(); assert.equal(route, null)
})
