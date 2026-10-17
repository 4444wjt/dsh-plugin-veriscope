import { RECEIPT_FILES } from './receipt.js'

export const CHANGE_LIMIT = 20
export const CHANGE_GROUPS = Object.freeze(['input', 'baseline', 'thresholds', 'upstream', 'plugin', 'environment'])
const GROUP_LABELS = Object.freeze({ input: '输入', baseline: '基线', thresholds: '阈值', upstream: '执行器', plugin: '插件', environment: '回放环境' })
const UPSTREAM_FILES = Object.freeze(['scripts/gate_replay.py', 'backend/config.py', 'backend/core/gate.py', 'backend/core/types.py', 'backend/core/attribution.py', 'backend/core/regression.py', 'backend/__init__.py', 'backend/core/__init__.py'])
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const has = (value, key) => Object.hasOwn(value, key)
const finite = value => typeof value === 'number' && Number.isFinite(value)
const fullMatch = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value
const validators = {
  path: value => typeof value === 'string' && value.length > 0 && value.length <= 32768 && !value.includes('\0'),
  hash: value => fullMatch(/^[a-f0-9]{64}$/, value),
  bytes: value => Number.isSafeInteger(value) && value >= 0,
  threshold: value => finite(value) && value >= 0 && value <= 1,
  version: value => fullMatch(/^v?(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/, value),
}

// This annotation cannot mint a receipt or change a verdict. Failure is explicit.
export function unverifiedChanges() {
  return { state: 'UNVERIFIED', items: [], total: 0, truncated: false, limit: CHANGE_LIMIT, unverified_groups: [...CHANGE_GROUPS] }
}

export function compareScopeChanges(before, after) {
  try { return compare(before, after) } catch { return unverifiedChanges() }
}

function compare(before, after) {
  const items = [], unknown = new Set()
  const mark = group => unknown.add(group)
  function shape(value, keys, group) {
    if (!record(value)) { mark(group); return false }
    if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !has(value, key))) mark(group)
    return true
  }
  function pair(left, right, keys, group) {
    const a = shape(left, keys, group), b = shape(right, keys, group)
    return a && b
  }
  function item(field, label, oldValue, newValue) { items.push({ field, label, before: oldValue, after: newValue }) }
  function leaf(left, right, field, label, kind, group) {
    if (!validators[kind](left) || !validators[kind](right)) { mark(group); return }
    if (left === right) return
    if (kind === 'path') item(field, label, '原位置', '当前位置（已变化）')
    else if (kind === 'hash') item(field, label, '原摘要', '摘要已变化')
    else item(field, label, left, right)
  }
  function fingerprint(left, right, key, label) {
    if (!pair(left, right, ['path', 'real_path', 'sha256', 'bytes'], key)) return
    leaf(left.path, right.path, `${key}.path`, `${label}位置`, 'path', key)
    leaf(left.real_path, right.real_path, `${key}.real_path`, `${label}实际位置`, 'path', key)
    leaf(left.sha256, right.sha256, `${key}.sha256`, `${label}内容摘要`, 'hash', key)
    leaf(left.bytes, right.bytes, `${key}.bytes`, `${label}字节数`, 'bytes', key)
  }
  function files(left, right, allowed, group, label) {
    if (!record(left) || !record(right)) { mark(group); return }
    if (!Object.keys(left).length || !Object.keys(right).length || [...Object.keys(left), ...Object.keys(right)].some(key => !allowed.includes(key))) mark(group)
    for (const key of allowed) if (has(left, key) || has(right, key)) leaf(left[key], right[key], `${group}.files.${key}`, `${label}文件 ${key}`, 'hash', group)
  }
  if (!record(before) || !record(after)) return unverifiedChanges()
  if (Object.keys(before).some(key => !CHANGE_GROUPS.includes(key)) || Object.keys(after).some(key => !CHANGE_GROUPS.includes(key))) CHANGE_GROUPS.forEach(mark)
  fingerprint(before.input, after.input, 'input', '输入')

  if (!has(before, 'baseline') || !has(after, 'baseline')) mark('baseline')
  else if (before.baseline === null && after.baseline === null) { /* Explicitly no baseline. */ }
  else if (before.baseline !== null && after.baseline !== null) fingerprint(before.baseline, after.baseline, 'baseline', '基线')
  else {
    item('baseline.present', '基线绑定', before.baseline === null ? '未绑定' : '已绑定', after.baseline === null ? '未绑定' : '已绑定')
    const present = before.baseline ?? after.baseline
    fingerprint(present, present, 'baseline', '基线')
  }

  if (pair(before.thresholds, after.thresholds, ['faith', 'ctx'], 'thresholds')) {
    leaf(before.thresholds.faith, after.thresholds.faith, 'thresholds.faith', 'Faithfulness 阈值', 'threshold', 'thresholds')
    leaf(before.thresholds.ctx, after.thresholds.ctx, 'thresholds.ctx', 'Context Precision 阈值', 'threshold', 'thresholds')
  }
  if (pair(before.upstream, after.upstream, ['root', 'contract_sha256', 'files'], 'upstream')) {
    leaf(before.upstream.root, after.upstream.root, 'upstream.root', '执行器位置', 'path', 'upstream')
    leaf(before.upstream.contract_sha256, after.upstream.contract_sha256, 'upstream.contract_sha256', '执行器契约摘要', 'hash', 'upstream')
    files(before.upstream.files, after.upstream.files, UPSTREAM_FILES, 'upstream', '执行器')
  }
  if (pair(before.plugin, after.plugin, ['root', 'version', 'files', 'coverage'], 'plugin')) {
    leaf(before.plugin.root, after.plugin.root, 'plugin.root', '插件位置', 'path', 'plugin')
    leaf(before.plugin.version, after.plugin.version, 'plugin.version', '插件版本', 'version', 'plugin')
    files(before.plugin.files, after.plugin.files, RECEIPT_FILES, 'plugin', '插件')
    const coverage = value => Array.isArray(value) && value.length > 0 && value.length <= RECEIPT_FILES.length && new Set(value).size === value.length && value.every(key => typeof key === 'string' && RECEIPT_FILES.includes(key))
    if (!coverage(before.plugin.coverage) || !coverage(after.plugin.coverage)) mark('plugin')
    else {
      for (const plugin of [before.plugin, after.plugin]) if (!record(plugin.files) || Object.keys(plugin.files).length !== plugin.coverage.length || plugin.coverage.some(key => !has(plugin.files, key))) mark('plugin')
      if (before.plugin.coverage.length !== after.plugin.coverage.length || before.plugin.coverage.some((key, index) => key !== after.plugin.coverage[index])) item('plugin.coverage', '插件绑定文件范围', '原覆盖范围', '覆盖范围已变化')
    }
  }
  if (pair(before.environment, after.environment, ['node', 'python', 'pandas'], 'environment')) {
    leaf(before.environment.node, after.environment.node, 'environment.node', '回放 Node 版本', 'version', 'environment')
    if (pair(before.environment.python, after.environment.python, ['path', 'real_path', 'sha256', 'bytes', 'version'], 'environment')) {
      for (const [key, label, kind] of [['path', '位置', 'path'], ['real_path', '实际位置', 'path'], ['sha256', '内容摘要', 'hash'], ['bytes', '字节数', 'bytes'], ['version', '版本', 'version']]) leaf(before.environment.python[key], after.environment.python[key], `environment.python.${key}`, `回放 Python ${label}`, kind, 'environment')
    }
    if (pair(before.environment.pandas, after.environment.pandas, ['version', 'metadata_sha256'], 'environment')) {
      leaf(before.environment.pandas.version, after.environment.pandas.version, 'environment.pandas.version', '回放 pandas 版本', 'version', 'environment')
      leaf(before.environment.pandas.metadata_sha256, after.environment.pandas.metadata_sha256, 'environment.pandas.metadata_sha256', '回放 pandas 元数据摘要', 'hash', 'environment')
    }
  }
  return { state: unknown.size ? 'UNVERIFIED' : 'COMPLETE', items: items.slice(0, CHANGE_LIMIT), total: items.length, truncated: items.length > CHANGE_LIMIT, limit: CHANGE_LIMIT, unverified_groups: CHANGE_GROUPS.filter(group => unknown.has(group)) }
}

export function renderChanges(changes) {
  if (!changes) return ['变化说明：未核实，不能据此声称绑定项全部未变。']
  const lines = changes.items.map(item => `${item.label}：${item.before} → ${item.after}`)
  if (changes.truncated) lines.push(`变化共 ${changes.total} 项，仅显示前 ${changes.limit} 项。`)
  if (changes.state !== 'COMPLETE') lines.push(`变化说明未核实：${changes.unverified_groups.map(group => GROUP_LABELS[group]).filter(Boolean).join('、') || '绑定范围'}；不能据此声称全部未变。`)
  else if (!changes.total) lines.push('变化说明：所列固定字段未发现变化。')
  lines.push('变化仅解释回执绑定项，不推断分数变化原因或回答事实正确性。')
  return lines
}
