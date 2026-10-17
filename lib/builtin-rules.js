import { ReviewError } from './errors.js'

export const BUILTIN_ENGINE = Object.freeze({ id: 'builtin-threshold-v1', version: '1.0.0' })
export const BUILTIN_FORMATS = Object.freeze(['gate-archive-v1', 'ragas-records-v1'])
export const BUILTIN_LIMITS = Object.freeze({ rows: 100_000, rules: 100, issues: 20 })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = value => typeof value === 'number' && Number.isFinite(value)
const text = value => typeof value === 'string' && value.length <= 128 && /\S/u.test(value) && !value.includes('\0')
const keys = (value, allowed, required = allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key))
const reject = (code, message) => { throw new ReviewError(code, message) }

export function validatePolicy(value) {
  if (!object(value) || value.schema_version !== 'GatePolicyV1') reject('BUILTIN_POLICY_INVALID', '需要受支持的 GatePolicyV1 策略。')
  if (!keys(value, ['schema_version', 'aggregation', 'population', 'rules']) || value.aggregation !== 'mean' || value.population !== 'all_provided_rows'
    || !Array.isArray(value.rules) || !value.rules.length || value.rules.length > BUILTIN_LIMITS.rules) reject('BUILTIN_POLICY_INVALID', '策略必须显式声明全部输入记录的等权均值及 1–100 项规则。')
  const names = new Set()
  for (const rule of value.rules) {
    if (!keys(rule, ['metric', 'unit', 'operator', 'threshold', 'range'], ['metric', 'unit', 'operator', 'threshold'])
      || !text(rule.metric) || !text(rule.unit) || !['gte', 'lte'].includes(rule.operator) || !finite(rule.threshold) || names.has(rule.metric)) reject('BUILTIN_POLICY_INVALID', '规则需要唯一指标名、单位、比较方向和有限阈值；不接受隐式默认值或未知字段。')
    names.add(rule.metric)
    if (Object.hasOwn(rule, 'range')) {
      const r = rule.range
      if (!keys(r, ['min', 'max'], []) || !Object.keys(r).length || Object.values(r).some(v => !finite(v))
        || (r.min !== undefined && r.max !== undefined && r.min > r.max)
        || (r.min !== undefined && rule.threshold < r.min) || (r.max !== undefined && rule.threshold > r.max)) reject('BUILTIN_POLICY_INVALID', '数值范围须为有限上下界，阈值须在所声明范围内。')
    }
  }
  return JSON.parse(JSON.stringify(value))
}

export function normalizeArchive(value, policy, format = 'gate-archive-v1') {
  if (!BUILTIN_FORMATS.includes(format)) reject('BUILTIN_FORMAT_UNSUPPORTED', '仅支持 GateArchiveV1 或指定的 Ragas records JSON 布局。')
  let source, rows
  if (format === 'ragas-records-v1') {
    if (!Array.isArray(value) || value.some(row => !object(row))) reject('BUILTIN_ARCHIVE_INVALID', 'Ragas 输入必须为 to_pandas().to_json(orient="records") 的对象数组，不读取汇总字典或其他布局。')
    source = { producer: 'ragas', version: null }
    rows = value.map((scores, index) => ({ id: `row-${index + 1}`, scores }))
  } else {
    if (!keys(value, ['schema_version', 'source', 'rows']) || value.schema_version !== 'GateArchiveV1'
      || !keys(value.source, ['producer', 'version'], ['producer']) || !text(value.source.producer)
      || (value.source.version !== undefined && value.source.version !== null && (typeof value.source.version !== 'string' || value.source.version.length > 128))
      || !Array.isArray(value.rows)) reject('BUILTIN_ARCHIVE_INVALID', '需要 GateArchiveV1、来源声明及逐条 scores，不能用汇总均值替代。')
    source = { producer: value.source.producer, version: value.source.version ?? null }
    rows = value.rows
  }
  if (rows.length > BUILTIN_LIMITS.rows) reject('FILE_LIMIT', '逐条记录超过 100,000 条上限。')
  const ids = new Set()
  const normalized = rows.map(row => {
    if (!keys(row, ['id', 'scores']) || !text(row.id) || ids.has(row.id) || !object(row.scores)) reject('BUILTIN_ARCHIVE_INVALID', '每条记录需要唯一的非空 id 和 scores 对象；不删除无效记录。')
    ids.add(row.id)
    // Select only explicitly requested, identically named columns. Missing and
    // malformed values are preserved, never coerced or filtered out.
    return { id: row.id, scores: Object.fromEntries(policy.rules.filter(rule => Object.hasOwn(row.scores, rule.metric)).map(rule => [rule.metric, row.scores[rule.metric]])) }
  })
  return { schema_version: 'GateArchiveV1', source, rows: normalized }
}

export function evaluateThresholds(archive, policy) {
  const metrics = policy.rules.map(rule => {
    const result = { metric: rule.metric, unit: rule.unit, operator: rule.operator, threshold: rule.threshold, range: rule.range ?? null,
      aggregation: 'mean', population: 'all_provided_rows', total_count: archive.rows.length, valid_count: 0, missing_count: 0, invalid_count: 0,
      mean: null, status: 'REVIEW', reason_code: 'EMPTY_DATA', issues: [], issues_truncated: false }
    let sum = 0, compensation = 0
    for (const row of archive.rows) {
      const value = row.scores[rule.metric]
      let reason
      if (!Object.hasOwn(row.scores, rule.metric) || value === null) { result.missing_count++; reason = 'MISSING_VALUE' }
      else if (!finite(value) || (rule.range?.min !== undefined && value < rule.range.min) || (rule.range?.max !== undefined && value > rule.range.max)) { result.invalid_count++; reason = 'INVALID_VALUE' }
      else {
        result.valid_count++
        // Sum before dividing so subnormal values are not rounded to zero
        // before aggregation. Kahan summation follows original row order.
        const term = value - compensation
        const next = sum + term
        compensation = (next - sum) - term; sum = next
      }
      if (reason) {
        if (result.issues.length < BUILTIN_LIMITS.issues) result.issues.push({ row_id: row.id, reason_code: reason })
        else result.issues_truncated = true
      }
    }
    if (!result.total_count) return result
    if (result.missing_count || result.invalid_count) { result.reason_code = 'METRIC_INCOMPLETE'; return result }
    let mean = sum / result.total_count
    if (!Number.isFinite(mean)) {
      // Retry only the arithmetic after sum overflow, with scaled finite
      // terms. This does not filter rows, round scores, or rerun any model.
      sum = 0; compensation = 0
      for (const row of archive.rows) {
        const term = row.scores[rule.metric] / result.total_count - compensation
        const next = sum + term
        compensation = (next - sum) - term; sum = next
      }
      mean = sum
    }
    if (!Number.isFinite(mean)) { result.reason_code = 'AGGREGATE_UNAVAILABLE'; return result }
    result.mean = Object.is(mean, -0) ? 0 : mean
    result.status = (rule.operator === 'gte' ? result.mean >= rule.threshold : result.mean <= rule.threshold) ? 'PASS' : 'FAIL'
    result.reason_code = result.status === 'PASS' ? 'THRESHOLD_PASSED' : 'THRESHOLD_FAILED'
    return result
  })
  const status = metrics.some(metric => metric.status === 'FAIL') ? 'FAIL' : metrics.every(metric => metric.status === 'PASS') ? 'PASS' : 'REVIEW'
  return { status, gate_passed: status === 'REVIEW' ? null : status === 'PASS', metrics }
}
