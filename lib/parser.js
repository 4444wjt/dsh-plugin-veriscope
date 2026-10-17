import { issue } from './errors.js'

export const GATE_PASS = '✅ 质量门禁通过，允许发布'
export const GATE_FAIL = '⛔ 质量门禁拦截，终止发布'

export function parseReplayOutput(stdout, archive, hasBaseline) {
  const lines = stdout.split(/\r?\n/)
  const errors = []
  const gateLines = lines.map((line, index) => ({ line, index })).filter(item => [GATE_PASS, GATE_FAIL].includes(item.line))
  if (gateLines.length !== 1) errors.push(issue('OUTPUT_CONTRACT', '裁决输出缺失或重复。'))
  const primaryLines = lines.filter(line => line.startsWith('主评测模型: '))
  if (primaryLines.length !== 1 || primaryLines[0] !== `主评测模型: ${archive.primary?.model}`) errors.push(issue('OUTPUT_MODEL_MISMATCH', '输出主模型与输入首个有效模型不一致。'))
  const fields = [
    ['faithfulness', '  平均忠实度 faithfulness:       '],
    ['context_precision', '  平均上下文精度 context_precision: '],
    ['pos_faithfulness', '  正向忠实度 faithfulness:       '],
    ['pos_context_precision', '  正向上下文精度 context_precision: '],
  ]
  for (const [key, prefix] of fields) {
    const found = lines.filter(line => line.startsWith(prefix))
    const token = found[0]?.slice(prefix.length)
    const value = token === 'None' || token === 'nan' ? null : token && Number(token)
    if (found.length !== 1 || (value !== null && (!Number.isFinite(value) || !/^-?\d/.test(token))) || value !== (archive.primary?.[key] ?? null)) {
      errors.push(issue('OUTPUT_METRIC_MISMATCH', `输出 ${key} 与归档不一致或无法解析。`))
    }
  }
  const regressionBlocked = lines.includes('⛔ 相对基线确定退步，拦截')
  if (regressionBlocked && !hasBaseline) errors.push(issue('UNEXPECTED_REGRESSION', '未传入基线却出现回归拦截。'))
  if (hasBaseline && !lines.some(line => line.startsWith('🔁 相对基线的回归对比：'))) errors.push(issue('MISSING_REGRESSION', '基线对比输出缺失。'))
  const gateLine = gateLines.at(-1) ?? null
  const modelConfirmed = primaryLines.length === 1 && primaryLines[0] === `主评测模型: ${archive.primary?.model}`
  return { errors, gate: gateLines.length === 1 ? gateLine.line === GATE_PASS : null, gateLine, regressionBlocked,
    confirmedFailure: modelConfirmed && (gateLine?.line === GATE_FAIL || (hasBaseline && regressionBlocked)),
  }
}

// Only the audited Python process determines numerical quality. This is protocol validation.
export function decideStatus(processResult, parsed, errors) {
  const completed = !processResult.reason && !processResult.error && !processResult.signal
  if (completed && processResult.code === 1 && parsed?.confirmedFailure) return 'FAIL'
  if (completed && processResult.code === 0 && parsed?.gate === true && !parsed.regressionBlocked && errors.length === 0) return 'PASS'
  return 'REVIEW'
}
