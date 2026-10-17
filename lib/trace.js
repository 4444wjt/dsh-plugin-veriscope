// Historical AI output is retained. These checks verify string presence only, not entailment.
export function describeHistoricalTrace(archive) {
  const rows = archive.result.model_dfs?.[archive.primary?.model]
  if (!Array.isArray(rows)) return { status: 'not_available', rejudged: false, rows: [] }
  const result = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (!row || !Object.hasOwn(row, 'hallucination_trace') || row.hallucination_trace === null) {
      result.push({ row_index: index, status: 'not_available', reason: '归档缺少 Trace；首版不补判。' }); continue
    }
    const original = row.hallucination_trace
    let value
    try { value = typeof original === 'string' ? JSON.parse(original) : original } catch {
      result.push({ row_index: index, status: 'unparseable', raw: original, reason: '原 Trace 无法解析，保留原值。' }); continue
    }
    const contexts = Array.isArray(row.contexts) ? row.contexts.filter(item => typeof item === 'string') : []
    const statements = Array.isArray(value?.statements) ? value.statements : []
    result.push({
      row_index: index, status: 'historical_ai', raw: original, rejudged: false,
      statements: statements.map((statement, statementIndex) => {
        const quote = statement?.evidence
        const literal = typeof quote === 'string' && quote.length > 0 && contexts.some(context => context.includes(quote))
        return { statement_index: statementIndex, original: statement, anchor_status: literal ? 'literal_present' : 'missing_or_unmatched', reason: literal ? '只确认原引文字符串存在，不证明语义支持。' : '出处为空或不能逐字匹配；保留原判定，不计为新增有依据结论。' }
      }),
      reason: '包括拒绝条目与诊断在内的原 Trace 已保留，未重新调用裁判。',
    })
  }
  return { status: result.some(row => row.status === 'historical_ai') ? 'historical_ai' : 'not_available', rejudged: false, rows: result }
}
