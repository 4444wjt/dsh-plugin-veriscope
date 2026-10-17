import { createReplayService, renderReport } from './replay.js'
import { createBuiltinService, renderBuiltinReport } from './builtin.js'
import { createStatusService, renderStatus } from './status.js'
import { createManagedService } from './managed.js'
import { createDoctorService, renderDoctor } from './doctor.js'
import { createListService, renderList } from './catalog.js'
import { createBatchService, renderBatch } from './batch.js'
import { createExportService, renderExport } from './export.js'
import { reportSchema, statusSchema, managedSchema, builtinReportSchema, toValueSpec } from './schema.js'
import { reasonMessage } from './reasons.js'

export const MCP_TOOL_NAMES = Object.freeze([
  'veriscope_doctor', 'veriscope_gate_replay', 'veriscope_gate_status', 'veriscope_gate_list',
  'veriscope_gate_check',
])

const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const threshold = description => ({ type: 'number', minimum: 0, maximum: 1, description })
const policyProperties = {
  run_id: { type: 'string', description: '已有运行的 UUID；仅查询当前状态根。' },
  faith: threshold('可选期望阈值；变化时须重放。'),
  ctx: threshold('可选期望阈值；变化时须重放。'),
  baseline_run_id: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '省略保持原基线；null表示无基线；UUID引用已有有效回执。' },
}
const utilitySchema = { type: 'object', required: ['schema_version'], properties: { schema_version: { type: 'string' } }, additionalProperties: true }

// Both hosts consume the same JSON Schema. Only DSH's registration boundary
// converts the standard required array into its value-schema DSL.
export function toolParameters(inputSchema) {
  // DSH alpha's value DSL cannot express numeric bounds. Keep bounds in the
  // canonical MCP schema; the shared services enforce them for BOTH hosts.
  const project = schema => {
    const { minimum, maximum, ...value } = schema
    if (value.properties) value.properties = Object.fromEntries(Object.entries(value.properties).map(([key, child]) => [key, project(child)]))
    if (value.items) value.items = project(value.items)
    if (value.oneOf) value.oneOf = value.oneOf.map(project)
    return value
  }
  return toValueSpec(project(inputSchema)).properties
}

export function createToolCatalog(serviceOptions = {}) {
  const options = { ...serviceOptions, env: Object.freeze({ ...(serviceOptions.env ?? process.env) }) }
  const replayService = createReplayService(options)
  const builtinService = createBuiltinService(options)
  const statusService = options.statusService ?? createStatusService(options)
  const managed = createManagedService({ ...options, statusService })
  const doctor = createDoctorService({ ...options, statusService })
  const list = createListService({ ...options, statusService })
  const batch = createBatchService({ ...options, replayService })
  const exporter = createExportService({ ...options, statusService })
  const tools = [
    {
      name: 'veriscope_gate_check',
      description: '只用 Node 按显式策略检查已有逐条评分，生成独立阈值门禁和 ReceiptV2。不需要 VeriScope 或 Python，不评分、不调用模型；不用于 bind/complete。',
      inputSchema: objectSchema({
        archive_path: { type: 'string', description: '已有评分 JSON 的非空绝对路径。' },
        policy_path: { type: 'string', description: 'GatePolicyV1 JSON 的非空绝对路径；必须明确指标、方向、单位及阈值。' },
        format: { type: 'string', enum: ['gate-archive-v1', 'ragas-records-v1'], description: '默认 gate-archive-v1；Ragas records 布局须显式指定，不自动猜测。' },
      }, ['archive_path', 'policy_path']),
      outputSchema: builtinReportSchema, annotations: { readOnlyHint: false }, presentation: 'utility', render: renderBuiltinReport,
      call: (args, context = {}) => builtinService.check(args, { signal: context.signal, sessionId: context.sessionId }),
    },
    {
      name: 'veriscope_gate_replay',
      description: '读取已有 VeriScope JSON 归档并重放门禁，写入报告与回执。返回 PASS／FAIL／REVIEW；不重新评测，不自动修复。',
      inputSchema: objectSchema({
        result_path: { type: 'string', description: '归档 JSON 路径；相对路径以 VERISCOPE_ROOT 为基准。' },
        baseline: { type: 'string', description: '可选基线归档路径，使用同一个 Python 脚本进行回归对比。' },
        faith: threshold('正向 Faithfulness 阈值，默认 0.8，范围 0–1。'),
        ctx: threshold('正向 Context Precision 阈值，默认 0.8，范围 0–1。'),
      }, ['result_path']),
      outputSchema: reportSchema, annotations: { readOnlyHint: false }, presentation: 'gate', render: renderReport,
      call: (args, context = {}) => replayService.replay(args, { signal: context.signal, sessionId: context.sessionId }),
    },
    {
      name: 'veriscope_gate_status', description: '只读检查回执当前有效性；不重新重放或评分。',
      inputSchema: objectSchema(policyProperties, ['run_id']), outputSchema: statusSchema,
      annotations: { readOnlyHint: true }, presentation: 'gate', render: renderStatus,
      call: (args, context = {}) => statusService.status(args, { signal: context.signal }),
    },
    {
      name: 'veriscope_doctor', description: '检查本机 VeriScope、Python、pandas、契约、状态根与最近回执；会写入并清理体检探针，环境就绪不代表门禁通过。',
      inputSchema: objectSchema({ engine: { type: 'string', enum: ['veriscope', 'builtin'], description: '默认 veriscope；builtin 仅检查 Node 与显式持久状态根，不探测 Python。' } }), outputSchema: utilitySchema,
      annotations: { readOnlyHint: false }, presentation: 'utility', render: renderDoctor,
      call: (args, context = {}) => doctor.doctor(args, { signal: context.signal }),
    },
    {
      name: 'veriscope_gate_list', description: '只读列出近期回执，逐条检查当前有效性，保留损坏记录。',
      inputSchema: objectSchema({ limit: { type: 'integer', minimum: 1, maximum: 200, description: '默认 50，允许 1–200。' } }),
      outputSchema: utilitySchema, annotations: { readOnlyHint: true }, presentation: 'utility', render: renderList,
      call: (args, context = {}) => list.list(args, { signal: context.signal }),
    },
    {
      name: 'veriscope_gate_batch', description: '按顺序重放多份已有归档并写记录，可取消；已确认 FAIL 优先，不重新评测。',
      inputSchema: objectSchema({
        paths: { type: 'array', items: { type: 'string' }, description: '归档路径数组；与 dir 二选一，最多 200 份。' },
        dir: { type: 'string', description: '只读取该目录直接包含的 JSON，不递归；与 paths 二选一。' },
        faith: policyProperties.faith, ctx: policyProperties.ctx,
        baseline: { type: 'string', description: '可选基线路径，使用同一 Python 门禁。' },
      }),
      outputSchema: utilitySchema, annotations: { readOnlyHint: false }, presentation: 'utility', render: renderBatch,
      call: (args, context = {}) => batch.batch(args, { signal: context.signal, sessionId: context.sessionId }),
    },
    {
      name: 'veriscope_gate_export', description: '将已有记录导出到状态根 exports。share 为可预览白名单求助摘要，非回执；md 为完整报告，json 保留原回执。不上传、不覆盖旧文件。',
      inputSchema: objectSchema({
        run_id: { type: 'string', description: '一个运行 UUID；与 run_ids 二选一。' },
        run_ids: { type: 'array', items: { type: 'string' }, description: '1–50 个运行 UUID。' },
        format: { type: 'string', enum: ['md', 'json', 'share'], description: '分享求助用 share；完整本地报告用 md，原回执用 json。share 文件为 Markdown，不能用于门禁放行。' },
      }, ['format']),
      outputSchema: utilitySchema, annotations: { readOnlyHint: false }, presentation: 'utility', render: renderExport,
      call: (args, context = {}) => exporter.export(args, { signal: context.signal }),
    },
    ...['bind', 'complete'].map(operation => ({
      name: `veriscope_gate_${operation}`,
      description: operation === 'bind' ? '登记本会话受管任务，绑定已有当前回执；不执行门禁。' : '仅当前PASS且与本会话绑定一致时登记完成；不授权外部发布。',
      inputSchema: objectSchema(operation === 'bind' ? { ...policyProperties,
        task_id: { type: 'string', description: '本会话任务名，1–80位字母、数字、下划线、点或连字符。' },
      } : { task_id: { type: 'string' }, run_id: { type: 'string' } }, ['task_id', 'run_id']),
      outputSchema: managedSchema, annotations: { readOnlyHint: false }, presentation: 'gate',
      render: value => `任务${operation === 'bind' ? '绑定' : '完成'}：${value.accepted ? '已接受' : '未接受'}\n原因：${reasonMessage(value.reason_code)} [${value.reason_code}]\n${value.status ? renderStatus(value.status) : '请确认本会话上下文、任务绑定和回执。'}`,
      // Managed operations derive identity only from the actual host context.
      // A caller-supplied sessionId is deliberately ignored here.
      call: (args, context = {}) => managed[operation](args, { ...context.execution, signal: context.signal }),
    })),
  ]
  return { tools, statusService, managed, dispose: () => managed.dispose() }
}
