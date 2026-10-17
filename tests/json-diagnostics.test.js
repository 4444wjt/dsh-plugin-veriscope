import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ReviewError } from '../lib/errors.js'
import { parseLocatedJson, readArchive, sha256 } from '../lib/source.js'
import { temporary } from './helpers.js'

const jsonMessage = 'JSON 语法、重复字段、数值或嵌套深度无效。'
function failure(raw) {
  let caught
  try { parseLocatedJson(raw) } catch (error) { caught = error }
  assert.ok(caught instanceof ReviewError)
  assert.equal(caught.code, 'INVALID_JSON')
  assert.equal(caught.message, jsonMessage)
  assert.deepEqual(Object.keys(caught.diagnostic).sort(), ['column', 'kind', 'line', 'location_kind', 'offset_utf16', 'pointer', 'position_basis'].sort())
  assert.equal(caught.diagnostic.position_basis, 'decoded_text_utf16')
  assert.equal(caught.diagnostic.location_kind, 'detected')
  return caught.diagnostic
}

test('JSON diagnostics preserve code/message and locate the offending token after CRLF', () => {
  const raw = '{\r\n "result": {\r\n  "summary": [ @ ]\r\n }\r\n}'
  assert.deepEqual(failure(raw), {
    kind: 'syntax', offset_utf16: raw.indexOf('@'), line: 3, column: 16,
    pointer: '/result/summary/0', position_basis: 'decoded_text_utf16', location_kind: 'detected',
  })
})

test('columns and offsets count Chinese and emoji as UTF-16 units, not bytes or glyphs', () => {
  const raw = '{"model":"中😀","summary":[@]}'
  const diagnostic = failure(raw)
  assert.equal(diagnostic.offset_utf16, 26)
  assert.equal(diagnostic.column, 27)
  assert.equal(diagnostic.line, 1)
  assert.equal(diagnostic.pointer, '/summary/0')
  assert.notEqual(diagnostic.offset_utf16, Buffer.byteLength(raw.slice(0, raw.indexOf('@'))))
})

test('bare CR and LF each advance a line, while CRLF advances once', () => {
  for (const newline of ['\r', '\n', '\r\n']) {
    const raw = `{${newline}"summary":[${newline}@]}`
    const diagnostic = failure(raw)
    assert.equal(diagnostic.line, 3)
    assert.equal(diagnostic.column, 1)
    assert.equal(diagnostic.offset_utf16, raw.indexOf('@'))
  }
})

test('missing colon and mismatched array close point at the actual discovered character', () => {
  const colon = '{"summary" []}'
  assert.equal(failure(colon).offset_utf16, colon.indexOf('['))
  assert.equal(failure(colon).pointer, '/summary')
  const close = '{"summary":[1}}'
  assert.equal(failure(close).offset_utf16, close.indexOf('}'))
  assert.equal(failure(close).pointer, '/summary')
})

test('EOF points one past the last UTF-16 unit without inventing a repair location', () => {
  for (const raw of ['', '{', '[1,', '{"summary":', '"unterminated', '"trailing\\']) {
    const diagnostic = failure(raw)
    assert.equal(diagnostic.kind, 'unexpected_end')
    assert.equal(diagnostic.offset_utf16, raw.length)
    assert.equal(diagnostic.line, 1)
    assert.equal(diagnostic.column, raw.length + 1)
  }
})

test('duplicate decoded keys identify the second key token, including escaped spelling', () => {
  const raw = '{"summary":[],"\\u0073ummary":[]}'
  const diagnostic = failure(raw)
  assert.equal(diagnostic.kind, 'duplicate_key')
  assert.equal(diagnostic.offset_utf16, raw.indexOf('"\\u0073ummary"'))
  assert.equal(diagnostic.pointer, '/summary')
})

test('invalid escapes, unicode escapes and literal controls have exact detected positions', () => {
  const escape = '{"model":"bad\\q"}'
  assert.equal(failure(escape).kind, 'invalid_escape')
  assert.equal(failure(escape).offset_utf16, escape.indexOf('q'))
  const unicode = '{"model":"\\u12g4"}'
  assert.equal(failure(unicode).kind, 'invalid_unicode_escape')
  assert.equal(failure(unicode).offset_utf16, unicode.indexOf('g'))
  const control = '{"model":"中😀\t"}'
  assert.equal(failure(control).kind, 'invalid_string')
  assert.equal(failure(control).offset_utf16, 13)
  assert.equal(failure(control).column, 14)
  const newline = '{"model":"bad\r\ntext"}'
  assert.equal(failure(newline).offset_utf16, newline.indexOf('\r'))
})

test('unknown keys, numeric object keys and dynamic model keys never enter diagnostics', () => {
  const secret = 'customer-secret/path~秘密'
  for (const raw of [
    `{"${secret}":@}`,
    `{"${secret}":{"summary":[],"summary":[]}}`,
    `{"${secret}":1,"${secret}":2}`,
    '{"123":@}',
    '{"model_dfs":{"summary":[@]}}',
    '{"model_dfs":{"private-model-name":[@]}}',
  ]) {
    const diagnostic = failure(raw)
    assert.equal(diagnostic.pointer, null)
    assert.equal(JSON.stringify(diagnostic).includes(secret), false)
    assert.equal(JSON.stringify(diagnostic).includes('private-model-name'), false)
  }
  assert.equal(failure('[{"summary":[@]}]').pointer, '/0/summary/0')
})

test('non-finite numeric literals and trailing data have distinct kinds', () => {
  const raw = '{"summary":[{"faithfulness":1e999}]}'
  const diagnostic = failure(raw)
  assert.equal(diagnostic.kind, 'non_finite_number')
  assert.equal(diagnostic.offset_utf16, raw.indexOf('1e999'))
  assert.equal(diagnostic.pointer, '/summary/0/faithfulness')
  const trailing = '{"summary":[]} \r\n unexpected-private-text'
  const suffix = failure(trailing)
  assert.equal(suffix.kind, 'trailing_content')
  assert.equal(suffix.offset_utf16, trailing.indexOf('unexpected'))
  assert.equal(suffix.line, 2)
  assert.equal(suffix.column, 2)
  assert.equal(JSON.stringify(suffix).includes('private-text'), false)
})

test('depth 128 remains accepted and depth 129 remains rejected at the next value', () => {
  const accepted = '['.repeat(128) + '0' + ']'.repeat(128)
  assert.doesNotThrow(() => parseLocatedJson(accepted))
  const rejected = '['.repeat(129) + '0' + ']'.repeat(129)
  const diagnostic = failure(rejected)
  assert.equal(diagnostic.kind, 'depth_limit')
  assert.equal(diagnostic.offset_utf16, 129)
  assert.equal(diagnostic.pointer, '/0'.repeat(129))
})

test('valid JSON corpus retains its original values and raw source locations', () => {
  const accepted = [
    'null', 'true', 'false', '0', '-0', '1.25E+3', '1e-999', '9007199254740993',
    '"\\ud800"', '"\\u0000"', '"中😀"', '"\\\"\\\\\\/\\b\\f\\n\\r\\t"',
    '[]', '{}', ' \r\n {"__proto__":{"a":1},"a/b~c":"\\u4e2d","summary":[]}\t',
  ]
  for (const raw of accepted) {
    const parsed = parseLocatedJson(raw)
    assert.equal(JSON.stringify(parsed.value), JSON.stringify(JSON.parse(raw)))
    assert.ok(parsed.locations.has(''))
  }
  assert.ok(Object.is(parseLocatedJson('-0').value, -0))
  const raw = '{"summary":[],"a/b~c":"\\u4e2d"}'
  const parsed = parseLocatedJson(raw)
  const location = parsed.locations.get('/a~1b~0c')
  assert.equal(raw.slice(location.start, location.end), '"\\u4e2d"')
  assert.equal(Object.getPrototypeOf(parseLocatedJson('{"__proto__":1}').value), null)
})

test('strict rejection corpus stays rejected instead of being automatically repaired', () => {
  for (const raw of [
    '01', '1.', '1e', '-', 'truefalse', '[1,]', '{"a":1,}', '{"summary":[}',
    '{"summary":[],"summary":[]}', '{"x":NaN}', '{"x":1e999}',
    '"\\v"', '"\\u12g4"', '"bad\nstring"', '\ufeff{"summary":[]}',
  ]) failure(raw)
})

test('readArchive passes through the located ReviewError and does not mutate source bytes', t => {
  const directory = temporary(t), file = path.join(directory, 'private archive.json')
  const bytes = Buffer.from('{\r\n"summary":[@]}')
  fs.writeFileSync(file, bytes)
  assert.throws(() => readArchive(file, 1000), error => {
    assert.ok(error instanceof ReviewError)
    assert.equal(error.code, 'INVALID_JSON')
    assert.equal(error.message, jsonMessage)
    assert.equal(error.diagnostic.line, 2)
    assert.equal(error.diagnostic.pointer, '/summary/0')
    assert.equal(JSON.stringify(error.diagnostic).includes(file), false)
    return true
  })
  assert.deepEqual(fs.readFileSync(file), bytes)
})

test('UTF-8 BOM is stripped only by archive decoding; positions refer to decoded text', t => {
  const directory = temporary(t), file = path.join(directory, 'bom.json')
  const valid = '{"summary":[]}'
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(valid)])
  fs.writeFileSync(file, bytes)
  const archive = readArchive(file, 1000)
  assert.equal(archive.raw, valid)
  assert.deepEqual(archive.bytes, bytes)
  assert.equal(archive.sha256, sha256(bytes))
  const malformed = '{"summary":[@]}'
  fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, 3), Buffer.from(malformed)]))
  assert.throws(() => readArchive(file, 1000), error => {
    assert.equal(error.code, 'INVALID_JSON')
    assert.equal(error.diagnostic.offset_utf16, malformed.indexOf('@'))
    return true
  })
})

test('archive structure failures keep their existing code and use schema-only pointers', t => {
  const directory = temporary(t), file = path.join(directory, 'structure.json')
  for (const [raw, code, pointer, token] of [
    ['{}', 'INVALID_INPUT', '/summary', null],
    ['{"summary":[1]}', 'INVALID_INPUT', '/summary/0', '1'],
    ['{"summary":[{"model":"","faithfulness":0.9}]}', 'INVALID_INPUT', '/summary/0/model', '""'],
    ['{"result":{"summary":[{"model":"m","faithfulness":2}]}}', 'INVALID_METRIC', '/result/summary/0/faithfulness', '2'],
  ]) {
    fs.writeFileSync(file, raw)
    assert.throws(() => readArchive(file, 1000), error => {
      assert.equal(error.code, code)
      assert.equal(error.diagnostic.kind, 'structure')
      assert.equal(error.diagnostic.pointer, pointer)
      assert.equal(error.diagnostic.offset_utf16, token === null ? raw.length : raw.indexOf(token))
      return true
    })
  }
  fs.writeFileSync(file, '{"summary":[{"model":"","faithfulness":null}]}')
  assert.equal(readArchive(file, 1000).primary, null)
})

test('invalid UTF-8 retains the existing input-read error without a guessed JSON location', t => {
  const directory = temporary(t), file = path.join(directory, 'encoding.json')
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe]))
  assert.throws(() => readArchive(file, 1000), error => {
    assert.equal(error.code, 'INPUT_READ_ERROR')
    assert.equal(error.diagnostic, undefined)
    return true
  })
})

test('ReviewError diagnostics contain fixed fields only and reject arbitrary pointer content', () => {
  const error = new ReviewError('INVALID_JSON', jsonMessage, {
    kind: 'syntax', offset_utf16: 0, line: 1, column: 1,
    pointer: '/private-account-value', quote: 'secret', filename: 'private-file',
    position_basis: 'invented', location_kind: 'repair',
  })
  assert.equal(error.diagnostic.pointer, null)
  assert.equal(error.diagnostic.position_basis, 'decoded_text_utf16')
  assert.equal(error.diagnostic.location_kind, 'detected')
  assert.equal(Object.hasOwn(error.diagnostic, 'quote'), false)
  assert.equal(Object.hasOwn(error.diagnostic, 'filename'), false)
  assert.equal(new ReviewError('OLD', 'unchanged').diagnostic, undefined)
  assert.equal(new ReviewError('OLD', 'unchanged', { kind: 'secret' }).diagnostic, undefined)
})
