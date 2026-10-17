import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createReplayService, renderReport } from './lib/replay.js'
import { reportSchemaSpec } from './lib/schema.js'
export const name = 'dsh-plugin-veriscope'
export const inject = ['tools']
const skillPath = fileURLToPath(new URL('./skills/dsh-plugin-veriscope/SKILL.md', import.meta.url))
export function apply(ctx) {
  const service = createReplayService()
  const disposers = []
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
      output: { schema: reportSchemaSpec, render: (_args, value) => [{ type: 'text', text: renderReport(value) }] },
      execute: (args, execution) => service.replay(args, { signal: execution?.signal }),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) { try { dispose?.() } catch {} }
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) { try { dispose?.() } catch {} } }
}
