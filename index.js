import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createReplayService, renderReport } from './lib/replay.js'
import { reportSchemaSpec } from './lib/schema.js'
import { statusSchemaSpec, managedSchemaSpec } from './lib/schema.js'
import { createStatusService, renderStatus } from './lib/status.js'
import { createManagedService, pluginConfiguration, sessionIdentity } from './lib/managed.js'
import { registerStatusBridge } from './lib/bridge.js'
import { createDoctorService, renderDoctor } from './lib/doctor.js'
import { createListService, renderList } from './lib/catalog.js'
import { createBatchService, renderBatch } from './lib/batch.js'
import { createExportService, renderExport } from './lib/export.js'
import { utilitySchemaSpec } from './lib/schema.js'
import { reasonMessage } from './lib/reasons.js'
export const name = 'dsh-plugin-veriscope'
export const inject = ['tools']
const skillPath = fileURLToPath(new URL('./skills/dsh-plugin-veriscope/SKILL.md', import.meta.url))
export function apply(ctx, rawConfig = {}) {
  const config = pluginConfiguration(rawConfig)
  const service = createReplayService()
  const statusService = createStatusService()
  const managed = createManagedService({ statusService })
  const lifetime = new AbortController(), sessionRuns = new Map()
  const disposers = []
  const signal = execution => execution?.signal ? AbortSignal.any([execution.signal, lifetime.signal]) : lifetime.signal
  const remember = (value, execution) => {
    const sessionId = sessionIdentity(execution), runId = value.run_id ?? value.status?.run_id
    if (sessionId && runId && !lifetime.signal.aborted) {
      if (!sessionRuns.has(sessionId) && sessionRuns.size < 256) sessionRuns.set(sessionId, new Set())
      const runs = sessionRuns.get(sessionId)
      if (runs && runs.size < 512) runs.add(runId)
    }
    if (value.schema_version !== '1.0') value.session_id = sessionId
    return value
  }
  const presentationMeta = (_args, value) => {
    const current = value.schema_version === 'GateStatusV1' ? value : value.status?.schema_version === 'GateStatusV1' ? value.status : null
    return { veriscope: {
      run_id: current?.run_id ?? value.run_id ?? null, session_id: value.session_id ?? value.execution?.session_id ?? null,
      historical_verdict: current?.historical_verdict ?? value.status ?? 'unknown',
      recorded_status: current?.current_verdict ?? 'REVIEW', checked_at_utc: current?.checked_at_utc ?? null,
    } }
  }
  try {
    const skills = ctx.get('skills')
    if (skills && typeof skills.register === 'function') disposers.push(skills.register({ name, description: '离线重放鉴真全域 VeriScope AI 归档门禁，保留失败、待复核和来源。', content: readFileSync(skillPath, 'utf8'), source: 'runtime', provider: name }))
    disposers.push(ctx.tools.register(defineTool({
      name: 'veriscope_gate_replay',
      description: '只读重放已有 VeriScope JSON 归档。返回 PASS／FAIL／REVIEW；不重新评测，不自动修复。',
      parameters: {
        result_path: { type: 'string', required: true, description: '归档 JSON 路径；相对路径以 VERISCOPE_ROOT 为基准。' },
        baseline: { type: 'string', description: '可选基线归档路径，使用同一个 Python 脚本进行回归对比。' },
        faith: { type: 'number', description: '正向 Faithfulness 阈值，默认 0.8，范围 0–1。' },
        ctx: { type: 'number', description: '正向 Context Precision 阈值，默认 0.8，范围 0–1。' },
      },
      output: { schema: reportSchemaSpec, presentationMeta, render: (_args, value) => [{ type: 'text', text: renderReport(value) }] },
      execute: async (args, execution) => remember(await service.replay(args, { signal: signal(execution), sessionId: sessionIdentity(execution) }), execution),
    })))
    const policyParameters = {
      run_id: { type: 'string', required: true, description: '已有运行的 UUID；仅查询当前状态根。' },
      faith: { type: 'number', description: '可选期望阈值；变化时须重放。' }, ctx: { type: 'number', description: '可选期望阈值；变化时须重放。' },
      baseline_run_id: { oneOf: [{ type: 'string' }, { type: 'null' }], description: '省略保持原基线；null表示无基线；UUID引用已有有效回执。' },
    }
    disposers.push(ctx.tools.register(defineTool({ name: 'veriscope_gate_status', description: '只读检查回执当前有效性；不重新重放或评分。', parameters: policyParameters,
      output: { schema: statusSchemaSpec, presentationMeta, render: (_args, value) => [{ type: 'text', text: renderStatus(value) }] },
      execute: async (args, execution) => remember(await statusService.status(args, { signal: signal(execution) }), execution),
    })))
    const utilityTools = [
      { name: 'veriscope_doctor', description: '检查本机 VeriScope、Python、pandas、契约、状态根与最近回执；环境就绪不代表门禁通过。', parameters: {}, call: (args, execution) => createDoctorService().doctor(args, { signal: signal(execution) }), render: renderDoctor },
      { name: 'veriscope_gate_list', description: '只读列出近期回执，逐条检查当前有效性，保留损坏记录。', parameters: { limit: { type: 'integer', description: '默认 50，允许 1–200。' } }, call: (args, execution) => createListService({ statusService }).list(args, { signal: signal(execution) }), render: renderList },
      { name: 'veriscope_gate_batch', description: '按顺序重放多份已有归档，可取消；已确认 FAIL 优先，不重新评测。', parameters: { paths: { type: 'array', items: { type: 'string' }, description: '归档路径数组；与 dir 二选一，最多 200 份。' }, dir: { type: 'string', description: '只读取该目录直接包含的 JSON，不递归；与 paths 二选一。' }, faith: policyParameters.faith, ctx: policyParameters.ctx, baseline: { type: 'string', description: '可选基线路径，使用同一 Python 门禁。' } }, call: (args, execution) => createBatchService({ replayService: service }).batch(args, { signal: signal(execution), sessionId: sessionIdentity(execution) }), render: renderBatch },
      { name: 'veriscope_gate_export', description: '将已有回执导出到状态根 exports；Markdown 区分历史裁决和当前有效性，JSON 保留原回执。不覆盖旧文件。', parameters: { run_id: { type: 'string', description: '一个运行 UUID；与 run_ids 二选一。' }, run_ids: { type: 'array', items: { type: 'string' }, description: '1–50 个运行 UUID。' }, format: { type: 'string', enum: ['md', 'json'], required: true } }, call: (args, execution) => createExportService({ statusService }).export(args, { signal: signal(execution) }), render: renderExport },
    ]
    for (const tool of utilityTools) disposers.push(ctx.tools.register(defineTool({ name: tool.name, description: tool.description, parameters: tool.parameters,
      output: { schema: utilitySchemaSpec, render: (_args, value) => [{ type: 'text', text: tool.render(value) }] },
      execute: async (args, execution) => {
        const value = await tool.call(args, execution)
        for (const item of value.items ?? []) if (item.run_id) remember(item, execution)
        return value
      },
    })))
    for (const [operation, description] of [['bind', '登记本会话受管任务，绑定已有当前回执；不执行门禁。'], ['complete', '仅当前PASS且与本会话绑定一致时登记完成；不授权外部发布。']]) {
      disposers.push(ctx.tools.register(defineTool({ name: `veriscope_gate_${operation}`, description,
        parameters: operation === 'bind' ? { ...policyParameters, task_id: { type: 'string', required: true, description: '本会话任务名，1–80位字母、数字、下划线、点或连字符。' } }
          : { task_id: { type: 'string', required: true }, run_id: { type: 'string', required: true } },
        output: { schema: managedSchemaSpec, presentationMeta, render: (_args, value) => [{ type: 'text', text: `任务${operation === 'bind' ? '绑定' : '完成'}：${value.accepted ? '已接受' : '未接受'}\n原因：${reasonMessage(value.reason_code)} [${value.reason_code}]\n${value.status ? renderStatus(value.status) : '请确认本会话上下文、任务绑定和回执。'}` }] },
        execute: async (args, execution) => remember(await managed[operation](args, { ...execution, signal: signal(execution) }), execution),
      })))
    }
    const bridge = ctx.inject(['webServer'], bridgeCtx => registerStatusBridge(bridgeCtx, statusService, sessionRuns))
    disposers.push(() => bridge.dispose())
    if (config.completionMode === 'remind') disposers.push(ctx.on('agent/turn-stopping', event => managed.remind(event)))
    disposers.push(() => { lifetime.abort(); managed.dispose(); sessionRuns.clear() })
  } catch (error) {
    for (const dispose of disposers.reverse()) { try { dispose?.() } catch {} }
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) { try { dispose?.() } catch {} } }
}
