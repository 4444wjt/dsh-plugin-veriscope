import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadDshSdk } from './lib/dsh-sdk.js'
import { createToolCatalog, toolParameters } from './lib/tools.js'
import { toValueSpec } from './lib/schema.js'
import { pluginConfiguration, sessionIdentity } from './lib/managed.js'
import { registerStatusBridge } from './lib/bridge.js'
const { defineTool } = await loadDshSdk()
export const name = 'dsh-plugin-veriscope'
export const inject = ['tools']
const skillPath = fileURLToPath(new URL('./skills/dsh-plugin-veriscope/SKILL.md', import.meta.url))
export function apply(ctx, rawConfig = {}) {
  const config = pluginConfiguration(rawConfig)
  const catalog = createToolCatalog()
  const { statusService, managed } = catalog
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
  const presentationMeta = (args, value) => {
    const current = value.schema_version === 'GateStatusV1' ? value : value.status?.schema_version === 'GateStatusV1' ? value.status : null
    const inputError = value.execution?.errors?.find(item => item.diagnostic)
    const diagnostic = inputError?.diagnostic
    return { veriscope: {
      run_id: current?.run_id ?? value.run_id ?? null, session_id: value.session_id ?? value.execution?.session_id ?? null,
      historical_verdict: current?.historical_verdict ?? value.status ?? 'unknown',
      recorded_status: current?.current_verdict ?? 'REVIEW', checked_at_utc: current?.checked_at_utc ?? null,
      policy: Object.fromEntries(['faith', 'ctx', 'baseline_run_id'].filter(key => Object.hasOwn(args ?? {}, key)).map(key => [key, args[key]])),
      ...(diagnostic && Number.isInteger(diagnostic.line) && diagnostic.line > 0 && Number.isInteger(diagnostic.column) && diagnostic.column > 0
        ? { input_diagnostic: { line: diagnostic.line, column: diagnostic.column, source: inputError.diagnostic_source === 'baseline' ? 'baseline' : 'input' } } : {}),
    } }
  }
  try {
    const skills = ctx.get('skills')
    if (skills && typeof skills.register === 'function') disposers.push(skills.register({ name, description: '离线重放鉴真全域 VeriScope AI 归档门禁，保留失败、待复核和来源。', content: readFileSync(skillPath, 'utf8'), source: 'runtime', provider: name }))
    for (const tool of catalog.tools) disposers.push(ctx.tools.register(defineTool({
      name: tool.name, description: tool.description, parameters: toolParameters(tool.inputSchema),
      output: { schema: toValueSpec(tool.outputSchema), ...(tool.presentation === 'gate' ? { presentationMeta } : {}),
        render: (_args, value) => [{ type: 'text', text: tool.render(value) }] },
      execute: async (args, execution) => {
        const value = await tool.call(args, { signal: signal(execution), sessionId: sessionIdentity(execution), execution })
        if (tool.presentation === 'gate') return remember(value, execution)
        for (const item of value.items ?? []) if (item.run_id) remember(item, execution)
        return value
      },
    })))
    const bridge = ctx.inject(['webServer'], bridgeCtx => registerStatusBridge(bridgeCtx, statusService, sessionRuns))
    disposers.push(() => bridge.dispose())
    if (config.completionMode === 'remind') disposers.push(ctx.on('agent/turn-stopping', event => managed.remind(event)))
    disposers.push(() => { lifetime.abort(); catalog.dispose(); sessionRuns.clear() })
  } catch (error) {
    for (const dispose of disposers.reverse()) { try { dispose?.() } catch {} }
    lifetime.abort(); catalog.dispose(); sessionRuns.clear()
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) { try { dispose?.() } catch {} } }
}
