import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { temporary } from './helpers.js'
import { previewRetention } from '../scripts/prune.mjs'

const digest = root => Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(item => item.isFile()).map(item => { const file = path.join(item.parentPath ?? item.path, item.name); return [path.relative(root, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')] }))
test('retention inventory preserves every byte including damaged and FAIL records', t => {
  const root = temporary(t), id = randomUUID(), run = path.join(root, 'runs', id)
  fs.mkdirSync(run, { recursive: true }); fs.mkdirSync(path.join(root, 'exports'))
  const receipt = { schema_version: 'ReceiptV1', payload: { run_id: id, historical_verdict: 'FAIL' } }
  fs.writeFileSync(path.join(run, 'receipt.json'), JSON.stringify(receipt)); fs.writeFileSync(path.join(run, 'report.json'), '{broken')
  fs.writeFileSync(path.join(root, 'exports', 'failure.json'), JSON.stringify(receipt))
  const before = digest(root), inventory = previewRetention({ VERISCOPE_STATE_DIR: root })
  assert.equal(inventory.deletion_supported, false); assert.equal(inventory.retention, 'indefinite')
  assert.equal(inventory.runs[0].historical_verdict, 'FAIL'); assert.equal(inventory.runs[0].association_verified, false)
  assert.deepEqual(inventory.exports[0].run_ids, [id]); assert.equal(inventory.exports[0].association, 'recorded_unverified')
  assert.deepEqual(digest(root), before)
})
test('retention inventory never creates an absent explicit root', t => {
  const parent = temporary(t), root = path.join(parent, 'not-created')
  assert.equal(previewRetention({ VERISCOPE_STATE_DIR: root }).exists, false)
  assert.equal(fs.existsSync(root), false)
  assert.throws(() => previewRetention({}), /VERISCOPE_STATE_DIR/)
})
test('retention scan is bounded and incomplete inventory is explicit', t => {
  const root = temporary(t)
  for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(root, name), 'x')
  assert.equal(previewRetention({ VERISCOPE_STATE_DIR: root }, { entryLimit: 1 }).truncated, true)
})
test('retention CLI rejects deletion flags without touching existing records', t => {
  const root = temporary(t); fs.writeFileSync(path.join(root, 'keep.txt'), 'evidence')
  const result = spawnSync(process.execPath, ['scripts/prune.mjs', '--delete'], { cwd: new URL('../', import.meta.url), env: { ...process.env, VERISCOPE_STATE_DIR: root }, encoding: 'utf8' })
  assert.equal(result.status, 2); assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'evidence')
})
