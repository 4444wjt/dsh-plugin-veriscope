import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { temporary } from './helpers.js'
import { createBuiltinService, renderBuiltinReport } from '../lib/builtin.js'
import { createStatusService, readRecord } from '../lib/status.js'
import { createManagedService } from '../lib/managed.js'
import { createExportService } from '../lib/export.js'
import { validToolArguments } from '../lib/mcp.js'

const repo = fileURLToPath(new URL('../', import.meta.url))
function fixture(t, tokens, { version = 'GatePolicyV2', threshold = '0.8', row, operator = 'gte', range, metric = 'quality', ragas = false } = {}) {
  const root = temporary(t), input = path.join(root, 'scores.json'), policy = path.join(root, 'policy.json')
  const key = JSON.stringify(metric)
  const scores = tokens.map((token, i) => ragas ? `{${key}:${token}}` : `{"id":"row-${i+1}","scores":{${key}:${token}}}`)
  fs.writeFileSync(input, ragas ? `[${scores.join(',')}]` : `{"schema_version":"GateArchiveV1","source":{"producer":"constructed-test"},"rows":[${scores.join(',')}]}`)
  fs.writeFileSync(policy, `{"schema_version":"${version}","aggregation":"mean","population":"all_provided_rows","rules":[{"metric":${key},"unit":"test","operator":"${operator}","threshold":${threshold}${row === undefined ? '' : ',"row_threshold":'+row}${range ? ',"range":'+range : ''}}]}`)
  const options = { env: { VERISCOPE_STATE_DIR: path.join(root, 'state') } }
  const args = { archive_path: input, policy_path: policy, ...(ragas ? { format: 'ragas-records-v1' } : {}) }
  return { root, args, options, service: createBuiltinService(options), statuses: createStatusService(options) }
}
async function run(t, tokens, options) { const f = fixture(t, tokens, options); const report = await f.service.check(f.args); return { ...f, report, metric: report.metrics[0] } }

test('V1 mean PASS exposes a low row diagnostically without silently changing its verdict', async t => {
  const { report, metric } = await run(t, ['.92','.41','.95','.87','.9'].map(v => '0'+v), { version: 'GatePolicyV1' })
  assert.equal(report.status, 'PASS'); assert.equal(report.engine.id, 'builtin-threshold-v1')
  assert.equal(metric.diagnostics.worst.row_id, 'row-2'); assert.equal(metric.diagnostics.worst.value, .41)
  assert.equal(metric.diagnostics.outside_mean_threshold_count, 1); assert.equal(metric.diagnostics.affects_verdict, false)
})

for (const version of ['GatePolicyV1','GatePolicyV2']) test(`decimal boundary explicitly versioned: ${version}`, async t => {
  const { report, metric } = await run(t, ['0.92','0.41','0.95','0.87','0.9'], { version, threshold:'0.81' })
  assert.equal(report.status, version === 'GatePolicyV1' ? 'FAIL' : 'PASS')
  if (version === 'GatePolicyV2') { assert.equal(metric.decimal.sum, '4.05'); assert.equal(metric.decimal.threshold, '0.81'); assert.equal(metric.decimal.mean_is_approximate, true) }
})

for (const [tokens, options, expected] of [
  [['0.92','0.41','0.95','0.87','0.9'], {row:'0.5'}, 'FAIL'],
  [['0.5','1'], {row:'0.5',threshold:'0.75'}, 'PASS'],
  [['0.41','null'], {row:'0.5'}, 'FAIL'],
  [['0.9','null'], {row:'0.5'}, 'REVIEW'],
  [['null'], {row:'0.5'}, 'REVIEW'],
  [[], {row:'0.5'}, 'REVIEW'],
  [['1','10'], {operator:'lte',threshold:'6',row:'9'}, 'FAIL'],
  [['9','9'], {operator:'lte',threshold:'9',row:'9'}, 'PASS'],
  [['9','null'], {operator:'lte',threshold:'9',row:'10'}, 'REVIEW'],
  [['11','null'], {operator:'lte',threshold:'9',row:'10'}, 'FAIL'],
  [['0.7'], {row:'0.5'}, 'FAIL'],
  [['0.41','1e-1025'], {row:'0.5'}, 'FAIL'],
  [['0.9','1e-1025'], {row:'0.5'}, 'REVIEW'],
  [['0.9','"0.1"'], {row:'0.5'}, 'REVIEW'],
  [['0.9','true'], {row:'0.5'}, 'REVIEW'],
]) test(`explicit row rule ${JSON.stringify(tokens)} ${JSON.stringify(options)} => ${expected}`, async t => {
  const { report, metric, statuses } = await run(t, tokens, options)
  assert.equal(report.status, expected); assert.equal(report.recording.receipt_available, true)
  assert.equal((await statuses.status({run_id:report.run_id})).current_verdict, expected)
  if (metric.row_constraint.status === 'FAIL') assert.equal(metric.reason_code, 'ROW_THRESHOLD_FAILED')
  if (metric.missing_count || metric.invalid_count) assert.equal(metric.mean, null)
})

for (const [value, threshold, operator, expected] of [
  ['0.799999999999999999999999999999','0.8','gte','FAIL'],
  ['0.800000000000000000000000000001','0.8','lte','FAIL'],
  ['9007199254740992','9007199254740993','gte','FAIL'],
  ['1e-400','0','lte','FAIL'],
  ['0.1000','1e-1','gte','PASS'],
  ['-0','-0','gte','PASS'],
]) test(`exact raw token comparison ${value} ${operator} ${threshold}`, async t => {
  const { report } = await run(t,[value],{threshold,operator})
  assert.equal(report.status,expected); assert.equal(report.recording.receipt_available,true)
})

test('V2 range checks distinguish digits lost by Number', async t => {
  const { report, metric } = await run(t,['0.100000000000000001'],{threshold:'0.1',range:'{"max":0.1}'})
  assert.equal(report.status,'REVIEW'); assert.equal(metric.invalid_count,1)
})
for (const options of [
  {threshold:'0.100000000000000001',range:'{"max":0.1}'},
  {threshold:'0.1',row:'0.100000000000000001',range:'{"max":0.1}'},
  {threshold:'0.1',range:'{"min":0.100000000000000001,"max":0.1}'},
  {threshold:'1e-1025'}, {threshold:'0.8',row:'"0.5"'},
  {version:'GatePolicyV1',row:'0.5'},
]) test(`invalid exact policy refuses execution: ${JSON.stringify(options)}`, async t => {
  const { report } = await run(t,['0.9'],options)
  assert.equal(report.status,'REVIEW'); assert.equal(report.execution.executed,false); assert.equal(report.recording.receipt_available,false)
  assert.ok(report.execution.errors.some(e => e.code==='BUILTIN_POLICY_INVALID'))
})

test('V2 original numeric policy -0 survives validation, receipt and status', async t => {
  const {report,statuses} = await run(t,['-0'],{threshold:'-0',row:'-0',range:'{"min":-0,"max":1}'})
  assert.equal(report.status,'PASS'); assert.equal((await statuses.status({run_id:report.run_id})).current_verdict,'PASS')
})

test('Ragas V2 column locators escape slash and tilde and preserve raw precision', async t => {
  const { report, metric } = await run(t,['0.100000000000000001'],{ragas:true,metric:'score/~',threshold:'0.1',row:'0.1',operator:'lte'})
  assert.equal(report.status,'FAIL'); assert.equal(metric.diagnostics.worst.decimal,'0.100000000000000001')
})

test('per-metric diagnostic follows lte direction and bounded row IDs', async t => {
  const { metric } = await run(t,Array.from({length:23},(_,i)=>String(i+1)),{operator:'lte',threshold:'0'})
  assert.equal(metric.diagnostics.worst.row_id,'row-23'); assert.equal(metric.diagnostics.outside_mean_threshold_count,23)
  assert.equal(metric.diagnostics.row_ids.length,20); assert.equal(metric.diagnostics.truncated,true)
})

test('known row FAIL survives receipt publication failure', async t => {
  const f = fixture(t,['0.41','null'],{row:'0.5'})
  const spy = mock.method(fs,'linkSync',()=>{throw new Error('publication failure')})
  let report; try {report=await f.service.check(f.args)} finally {spy.mock.restore()}
  assert.equal(report.status,'FAIL'); assert.equal(report.judgement,'FAIL'); assert.equal(report.recording.receipt_available,false)
})

test('V2 receipt cannot authorize bind/complete and exports actual row rule plus decimal basis', async t => {
  const f = await run(t,['0.9'],{row:'0.5'}), managed = createManagedService(f.options)
  const execution = {agent:{session:{id:'actual-test-session'}}}
  for (const name of ['bind','complete']) assert.equal((await managed[name]({task_id:'t',run_id:f.report.run_id},execution)).reason_code,'BUILTIN_MANAGED_UNSUPPORTED')
  managed.dispose()
  const record = readRecord({run_id:f.report.run_id},f.options)
  assert.equal(record.receipt.payload.engine.id,'builtin-threshold-v2')
  const md = await createExportService(f.options).export({run_id:f.report.run_id,format:'md'})
  assert.equal(md.exported,true); assert.match(fs.readFileSync(md.path,'utf8'),/逐条规则.*0.5/)
  assert.match(renderBuiltinReport(f.report),/诊断（不改裁决）/)
})

test('V2 CLI boundary uses exact source tokens, not reserialized Numbers', t => {
  const f=fixture(t,['9007199254740992'],{threshold:'9007199254740993'})
  const child=spawnSync(process.execPath,['scripts/check.mjs','--archive',f.args.archive_path,'--policy',f.args.policy_path,'--json'],{cwd:repo,env:{SystemRoot:process.env.SystemRoot,PATH:'',...f.options.env},windowsHide:true,encoding:'utf8'})
  assert.equal(child.status,1,child.stderr); assert.equal(JSON.parse(child.stdout).metrics[0].decimal.threshold,'9007199254740993')
})

test('V2 text fallback has no legacy card controls or network request', () => {
  let component
  const React={createElement:(tag,props,...children)=>({tag,props,children}),useState:initial=>[initial,()=>{}],useRef:()=>({}),useCallback:fn=>fn,useEffect(){}}
  vm.runInNewContext(fs.readFileSync(path.join(repo,'client.js'),'utf8'),{AbortController,fetch:()=>{throw Error('must not fetch')},window:{__ModuleLoader__:{load:({factory})=>factory(()=>React).apply({slots:{inject:(_n,fn)=>[...fn()],register:(_s,v)=>{component=v}}})}}})
  const value=component({block:{meta:{veriscope:{engine_id:'builtin-threshold-v2',builtin_text:'均值通过；逐条失败。'}}}})
  assert.equal(value.tag,'pre'); assert.equal(value.props['data-veriscope-mode'],'builtin-text'); assert.doesNotMatch(JSON.stringify(value),/button|Python|正向/)
})

test('V2 shipped policy schema accepts optional row rule and refuses unknown fields', () => {
  const schema=JSON.parse(fs.readFileSync(path.join(repo,'schemas/gate-policy-v2.schema.json')))
  const policy={schema_version:'GatePolicyV2',aggregation:'mean',population:'all_provided_rows',rules:[{metric:'q',unit:'ratio',operator:'gte',threshold:.8,row_threshold:.5}]}
  assert.equal(validToolArguments(policy,schema),true); assert.equal(validToolArguments({...policy,diagnostics:{min_row:.5}},schema),false)
})
