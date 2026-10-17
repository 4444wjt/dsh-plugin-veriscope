import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { temporary } from './helpers.js'

const sdkName = '@deepseek-ai/dsh-tools'
const expected = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).peerDependencies[sdkName]

function fixture(t, { installed = true, metadata, entry = 'export const defineTool = value => value', exposeMetadata = true } = {}) {
  const root = temporary(t), sdkRoot = path.join(root, 'node_modules', sdkName)
  fs.mkdirSync(path.join(root, 'lib'))
  fs.copyFileSync(new URL('../lib/dsh-sdk.js', import.meta.url), path.join(root, 'lib/dsh-sdk.js'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', peerDependencies: { [sdkName]: expected } }))
  if (installed) {
    fs.mkdirSync(sdkRoot, { recursive: true })
    fs.writeFileSync(path.join(sdkRoot, 'package.json'), metadata ?? JSON.stringify({ name: sdkName, version: expected, type: 'module',
      exports: { '.': './index.js', ...(exposeMetadata ? { './package.json': './package.json' } : {}) } }))
    fs.writeFileSync(path.join(sdkRoot, 'index.js'), entry)
  }
  const source = `try { const {loadDshSdk}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'lib/dsh-sdk.js')).href)}); const sdk=await loadDshSdk(); console.log(JSON.stringify({ok:true,defineTool:typeof sdk.defineTool})) } catch(error) { console.log(JSON.stringify({ok:false,code:error.code,message:error.message})); process.exitCode=2 }`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true })
  assert.equal(result.error, undefined)
  return { root, result, value: JSON.parse(result.stdout) }
}

test('DSH bootstrap loads the exact peer version and its actual defineTool export', t => {
  const f = fixture(t)
  assert.equal(f.result.status, 0)
  assert.deepEqual(f.value, { ok: true, defineTool: 'function' })
})

test('a missing optional SDK gives an actionable DSH error and a separate MCP entry', t => {
  const f = fixture(t, { installed: false })
  assert.equal(f.result.status, 2)
  assert.equal(f.value.code, 'SDK_MISSING')
  assert.match(f.value.message, /\[SDK_MISSING\].*veriscope-mcp/)
})

test('a mismatched SDK version is rejected before any SDK entry code can execute', t => {
  const entry = 'import fs from "node:fs"; fs.writeFileSync("sdk-executed", "must not run"); throw new Error("IMPORT_SENTINEL")'
  const metadata = JSON.stringify({ name: sdkName, version: '999.0.0', type: 'module', exports: { '.': './index.js', './package.json': './package.json' } })
  const f = fixture(t, { metadata, entry })
  assert.equal(f.result.status, 2); assert.equal(f.value.code, 'SDK_INCOMPATIBLE')
  assert.ok(f.value.message.includes(expected)); assert.match(f.value.message, /999\.0\.0/)
  assert.equal(fs.existsSync(path.join(f.root, 'sdk-executed')), false)
  assert.doesNotMatch(f.result.stdout + f.result.stderr, /IMPORT_SENTINEL/)
})

test('malformed SDK package metadata is rejected without reflecting parser or path details', t => {
  const f = fixture(t, { metadata: '{ invalid metadata' })
  assert.equal(f.value.code, 'SDK_INCOMPATIBLE')
  assert.equal(f.value.message.includes(f.root), false)
  assert.doesNotMatch(f.value.message, /invalid metadata/)
})

test('invalid version metadata never reflects arbitrary content', t => {
  const secret = 'SDK_METADATA_SECRET_SENTINEL'
  const f = fixture(t, { metadata: JSON.stringify({ name: sdkName, version: secret, type: 'module', exports: { '.': './index.js', './package.json': './package.json' } }) })
  assert.equal(f.value.code, 'SDK_INCOMPATIBLE')
  assert.equal((f.result.stdout + f.result.stderr).includes(secret), false)
})

test('an SDK that hides package metadata is rejected rather than guessed compatible', t => {
  const f = fixture(t, { exposeMetadata: false })
  assert.equal(f.value.code, 'SDK_INCOMPATIBLE')
})

for (const entry of ['export const other = () => {}', 'export const defineTool = 1']) test(`an unavailable defineTool interface is diagnosed (${entry})`, t => {
  const f = fixture(t, { entry })
  assert.equal(f.result.status, 2); assert.equal(f.value.code, 'SDK_INCOMPATIBLE')
  assert.match(f.value.message, /defineTool/)
})

test('SDK load exceptions produce a fixed diagnostic without leaking their message', t => {
  const secret = 'SDK_LOAD_SECRET_SENTINEL', f = fixture(t, { entry: `throw new Error(${JSON.stringify(secret)})` })
  assert.equal(f.value.code, 'SDK_LOAD_FAILED')
  assert.equal((f.result.stdout + f.result.stderr).includes(secret), false)
})

test('a missing transitive dependency is a load failure, not a missing top-level SDK', t => {
  const f = fixture(t, { entry: 'import "absent-veriscope-sdk-fixture-dependency"; export const defineTool = x => x' })
  assert.equal(f.value.code, 'SDK_LOAD_FAILED')
  assert.doesNotMatch(f.value.message, /absent-veriscope-sdk-fixture-dependency/)
})
