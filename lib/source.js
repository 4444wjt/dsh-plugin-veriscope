import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ReviewError, safeDiagnosticPointer } from './errors.js'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const escapePointer = value => String(value).replaceAll('~', '~0').replaceAll('/', '~1')

// Positions refer to the decoded JavaScript string, not UTF-8 file bytes or
// an inferred edit. A CRLF pair is one newline; columns count UTF-16 units.
function jsonDiagnostic(raw, kind, at, pointer) {
  const offset = Math.min(raw.length, Math.max(0, at))
  let line = 1, column = 1
  for (let index = 0; index < offset; index++) {
    if (raw[index] === '\r') {
      line++; column = 1
      if (raw[index + 1] === '\n' && index + 1 < offset) index++
    } else if (raw[index] === '\n') { line++; column = 1 }
    else column++
  }
  return {
    kind, offset_utf16: offset, line, column, pointer: safeDiagnosticPointer(pointer),
    position_basis: 'decoded_text_utf16', location_kind: 'detected',
  }
}

// Index original JSON tokens. Evidence quotes use original bytes, not reserialized values.
export function parseLocatedJson(raw) {
  const locations = new Map()
  let offset = 0
  const whitespace = () => { while (offset < raw.length && /[ \t\r\n]/.test(raw[offset])) offset++ }
  const invalid = (kind, pointer, at = offset) => {
    throw new ReviewError('INVALID_JSON', 'JSON 语法、重复字段、数值或嵌套深度无效。', jsonDiagnostic(raw, kind, at, pointer))
  }
  const syntax = pointer => invalid(offset >= raw.length ? 'unexpected_end' : 'syntax', pointer)
  function stringToken(pointer) {
    const start = offset++
    while (offset < raw.length) {
      if (raw[offset] === '\\') {
        offset++
        if (offset >= raw.length) invalid('unexpected_end', pointer)
        if (raw[offset] === 'u') {
          for (let index = 1; index <= 4; index++) {
            if (offset + index >= raw.length) invalid('unexpected_end', pointer, raw.length)
            if (!/[0-9a-fA-F]/.test(raw[offset + index])) invalid('invalid_unicode_escape', pointer, offset + index)
          }
          offset += 5
        } else {
          if (!'"\\/bfnrt'.includes(raw[offset])) invalid('invalid_escape', pointer)
          offset++
        }
        continue
      }
      if (raw.charCodeAt(offset) < 0x20) invalid('invalid_string', pointer)
      if (raw[offset++] === '"') return JSON.parse(raw.slice(start, offset))
    }
    invalid('unexpected_end', pointer, raw.length)
  }
  function visit(pointer, depth, diagnosticPointer) {
    whitespace()
    if (depth > 128) invalid('depth_limit', diagnosticPointer)
    const start = offset
    let value
    if (raw[offset] === '{') {
      offset++; whitespace(); value = Object.create(null)
      if (raw[offset] !== '}') {
        while (true) {
          if (raw[offset] !== '"') syntax(diagnosticPointer)
          const keyStart = offset
          const key = stringToken(diagnosticPointer)
          const childPointer = diagnosticPointer === null || diagnosticPointer.endsWith('/model_dfs') || /^(?:0|[1-9]\d*)$/.test(key)
            ? null : safeDiagnosticPointer(`${diagnosticPointer}/${escapePointer(key)}`)
          if (Object.hasOwn(value, key)) invalid('duplicate_key', childPointer, keyStart)
          whitespace(); if (raw[offset] !== ':') syntax(childPointer)
          offset++
          value[key] = visit(`${pointer}/${escapePointer(key)}`, depth + 1, childPointer)
          whitespace()
          if (raw[offset] !== ',') break
          offset++; whitespace()
        }
      }
      if (raw[offset] !== '}') syntax(diagnosticPointer)
      offset++
    } else if (raw[offset] === '[') {
      offset++; whitespace(); value = []
      if (raw[offset] !== ']') {
        while (true) {
          value.push(visit(`${pointer}/${value.length}`, depth + 1, diagnosticPointer === null ? null : `${diagnosticPointer}/${value.length}`)); whitespace()
          if (raw[offset] !== ',') break
          offset++; whitespace()
        }
      }
      if (raw[offset] !== ']') syntax(diagnosticPointer)
      offset++
    } else if (raw[offset] === '"') value = stringToken(diagnosticPointer)
    else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(offset))
      if (!match) syntax(diagnosticPointer)
      offset += match[0].length
      try { value = JSON.parse(match[0]) } catch { invalid('syntax', diagnosticPointer, start) }
      if (typeof value === 'number' && !Number.isFinite(value)) invalid('non_finite_number', diagnosticPointer, start)
    }
    locations.set(pointer, { start, end: offset })
    return value
  }
  const value = visit('', 0, '')
  whitespace(); if (offset !== raw.length) invalid('trailing_content', '', offset)
  return { value, locations }
}

export function readArchive(filename, limit) {
  let handle
  try {
    const realPath = fs.realpathSync(filename)
    handle = fs.openSync(realPath, 'r')
    const stat = fs.fstatSync(handle)
    if (!stat.isFile()) throw new ReviewError('INVALID_INPUT', '输入必须是普通文件。')
    if (stat.size > limit) throw new ReviewError('INPUT_TOO_LARGE', '输入超过 10MiB 限制。')
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    let length = 0
    while (length < buffer.length) {
      const count = fs.readSync(handle, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    if (length > limit || length > stat.size || fs.fstatSync(handle).size !== stat.size) throw new ReviewError('INPUT_CHANGED', '读取过程中输入变化或超限，请重新核实归档。')
    const bytes = buffer.subarray(0, length)
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsed = parseLocatedJson(raw)
    const wrapped = parsed.value && typeof parsed.value.result === 'object' && parsed.value.result !== null && !Array.isArray(parsed.value.result)
    const result = wrapped ? parsed.value.result : parsed.value
    const prefix = wrapped ? '/result' : ''
    const rejectField = (code, message, pointer) => {
      const location = parsed.locations.get(pointer)
      throw new ReviewError(code, message, jsonDiagnostic(raw, 'structure', location?.start ?? raw.length, pointer))
    }
    if (!result || Array.isArray(result) || !Array.isArray(result.summary)) rejectField('INVALID_INPUT', '缺少 summary 列表。', `${prefix}/summary`)
    const invalidSummaryIndex = result.summary.findIndex(item => !item || typeof item !== 'object' || Array.isArray(item))
    if (invalidSummaryIndex !== -1) rejectField('INVALID_INPUT', 'summary 条目必须是对象。', `${prefix}/summary/${invalidSummaryIndex}`)
    const primaryIndex = result.summary.findIndex(item => item.faithfulness !== null && item.faithfulness !== undefined)
    const primary = result.summary[primaryIndex] ?? null
    if (primary && (typeof primary.model !== 'string' || !primary.model.trim() || /[\r\n\0]/.test(primary.model))) rejectField('INVALID_INPUT', '主模型名称缺失或包含控制字符。', `${prefix}/summary/${primaryIndex}/model`)
    for (const [index, entry] of result.summary.entries()) {
      for (const key of ['faithfulness', 'context_precision', 'pos_faithfulness', 'pos_context_precision']) {
        const value = entry[key]
        if (value !== undefined && value !== null && (typeof value !== 'number' || value < 0 || value > 1 || !Number.isFinite(value))) rejectField('INVALID_METRIC', `归档指标 ${key} 必须为 0–1 数值或 null。`, `${prefix}/summary/${index}/${key}`)
      }
    }
    return { path: realPath, bytes, raw, sha256: sha256(bytes), locations: parsed.locations, result, prefix: wrapped ? '/result' : '', primaryIndex, primary }
  } catch (error) {
    if (error instanceof ReviewError) throw error
    throw new ReviewError('INPUT_READ_ERROR', `无法读取 UTF-8 JSON 归档：${filename}`)
  } finally { if (handle !== undefined) fs.closeSync(handle) }
}

export function sourceEvidence(source, pointer, sourceId) {
  const location = source.locations.get(pointer)
  if (!location) throw new ReviewError('INVALID_ANCHOR', `缺少原文位置：${pointer}`)
  return {
    source_id: sourceId, kind: 'archive_field', path: source.path, sha256: source.sha256,
    locator: { json_pointer: pointer, line: source.raw.slice(0, location.start).split('\n').length, start: location.start, end: location.end },
    quote: source.raw.slice(location.start, location.end),
  }
}

export function verifyEvidence(evidence, source) {
  if (evidence.sha256 !== sha256(source.raw) || evidence.path !== source.path) return false
  const location = source.locations.get(evidence.locator.json_pointer)
  return Boolean(location && evidence.locator.start === location.start && evidence.locator.end === location.end && evidence.quote === source.raw.slice(location.start, location.end))
}

export function verifyContract(root, contract) {
  const actual = {}
  for (const [relative, expected] of Object.entries(contract.files)) {
    const candidate = path.resolve(root, relative)
    if (path.relative(root, candidate).startsWith('..') || path.isAbsolute(path.relative(root, candidate))) throw new ReviewError('CONTRACT_MISMATCH', '脚本契约路径超出根目录。')
    try { actual[relative] = sha256(fs.readFileSync(candidate)) } catch { throw new ReviewError('CONTRACT_MISMATCH', `无法读取脚本契约文件：${relative}`) }
    if (actual[relative] !== expected) throw new ReviewError('CONTRACT_MISMATCH', `上游文件版本变化，需要重新核验退出码和输出契约：${relative}`)
  }
  return actual
}
