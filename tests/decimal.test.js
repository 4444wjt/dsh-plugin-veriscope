import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DECIMAL_LIMITS, parseDecimalToken, compareDecimal, sumDecimals, compareMean, decimalString, numberToken } from '../lib/decimal.js'
import { parseLocatedJson } from '../lib/source.js'

const d = parseDecimalToken
const sum = tokens => sumDecimals(tokens.map(d))

test('decimal tokens retain precision beyond binary floats and safe integers', () => {
  assert.equal(compareDecimal(d('0.100000000000000001'), d('0.1')), 1)
  assert.equal(compareDecimal(d('9007199254740993'), d('9007199254740992')), 1)
  assert.equal(compareDecimal(d('-9007199254740993'), d('-9007199254740992')), -1)
  assert.equal(decimalString(d('9007199254740993')), '9007199254740993')
})

test('scientific notation and trailing zeros normalize to the same exact value', () => {
  assert.deepEqual(d('0.1000'), { coefficient: 1n, exponent: -1 })
  for (const token of ['1e-1', '0.1', '0.1000', '1000e-4', '1E-0001']) assert.equal(compareDecimal(d(token), d('0.1')), 0)
  assert.equal(decimalString(d('123.45000e2')), '12345')
  assert.equal(decimalString(d('1e-400')), '1e-400')
  assert.equal(compareDecimal(d('1e-400'), d('0')), 1)
  assert.equal(compareDecimal(d('1e-400'), d('2e-400')), -1)
})

test('zero, negative zero and mixed signs have exact arithmetic', () => {
  for (const token of ['0', '-0', '0.000', '-0e1024', '0e-1024']) {
    assert.deepEqual(d(token), { coefficient: 0n, exponent: 0 })
    assert.equal(decimalString(d(token)), '0')
  }
  assert.deepEqual(sum(['1e1000', '-1e1000', '1e-400', '-1e-400']), { coefficient: 0n, exponent: 0 })
  assert.equal(decimalString(sum(['-1.2', '0.3', '0.01'])), '-0.89')
  assert.equal(decimalString(sum(['1e1000', '-1e1000', '0.1'])), '0.1')
  assert.equal(decimalString(sumDecimals([])), '0')
})

test('mean comparisons use exact sum versus threshold times count', () => {
  assert.equal(compareMean(sum(['0.9', '0.8', '0.73']), 3, d('0.81')), 0)
  assert.equal(compareMean(sum(['0.9', '0.8', '0.729999999999999999']), 3, d('0.81')), -1)
  assert.equal(compareMean(sum(['0.9', '0.8', '0.730000000000000001']), 3, d('0.81')), 1)
  assert.equal(compareMean(sum(['1', '0', '0']), 3, d('0.3333333333333333333333333333333333')), 1)
  assert.equal(compareMean(sum(['1e-400', '1e-400']), 2, d('1e-400')), 0)
  assert.equal(compareMean(sum(['-2', '-4']), 2, d('-3')), 0)
})

test('exact inclusive endpoints remain distinct from adjacent decimal values', () => {
  const min = d('0'), max = d('1')
  assert.equal(compareDecimal(d('0e-1024'), min), 0)
  assert.equal(compareDecimal(d('-1e-400'), min), -1)
  assert.equal(compareDecimal(d('1.000000000000000001'), max), 1)
  assert.equal(compareDecimal(d('0.999999999999999999'), max), -1)
  assert.equal(compareDecimal(d('1.000'), max), 0)
})

test('limits are checked before unbounded exponent or BigInt power work', () => {
  assert.deepEqual(DECIMAL_LIMITS, { token_length: 1024, exponent: 1024 })
  assert.equal(compareDecimal(d('1e1024'), d('1e-1024')), 1)
  assert.equal(decimalString(d('1e1024')), '1e1024')
  assert.equal(d('9'.repeat(1024)).coefficient.toString().length, 1024)
  assert.equal(d('1e000000001024').exponent, 1024)
  for (const token of ['1'.repeat(1025), '1e1025', '1e-1025', '1e99999999999999999', '0e99999999999999999', '-0e-1025', '10e1024', '0.1e-1024']) {
    assert.throws(() => d(token), { code: 'DECIMAL_LIMIT' })
  }
  assert.equal(d('0e-00000000001024').coefficient, 0n)
})

test('sums keep bounded input exponents even when a carry grows the canonical exponent', () => {
  const value = sum(['9e1024', '1e1024'])
  assert.equal(value.exponent, 1024)
  assert.equal(decimalString(value), '1e1025')
  assert.equal(compareMean(value, 2, d('5e1024')), 0)
})

test('invalid JSON numbers and invalid arithmetic arguments fail explicitly', () => {
  for (const token of [null, 0.1, '', ' 0.1', '0.1 ', '1\n', '1\r\n', '+1', '.1', '1.', '01', '--1', 'NaN', 'Infinity', '1e', '0x10', '"0.9"']) {
    assert.throws(() => d(token), { code: 'DECIMAL_TOKEN_INVALID' })
  }
  for (const count of [0, -1, 1.1, Infinity, '2', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => compareMean(d('1'), count, d('1')), { code: 'DECIMAL_TOKEN_INVALID' })
  assert.throws(() => sumDecimals(null), { code: 'DECIMAL_TOKEN_INVALID' })
  assert.throws(() => compareDecimal({ coefficient: 1, exponent: 0 }, d('1')), { code: 'DECIMAL_TOKEN_INVALID' })
  assert.throws(() => compareDecimal({ coefficient: 1n, exponent: 1000000000 }, d('1')), { code: 'DECIMAL_LIMIT' })
})

test('canonical decimal text round trips exactly where token limits allow', () => {
  for (const token of ['-0.0001', '1200', '0.81', '1e127', '1e128', '-1e-126', '-1e-127', '12.340e-400', '123456789.01234567890123456789']) {
    const text = decimalString(d(token))
    assert.equal(compareDecimal(d(text), d(token)), 0)
    assert.equal(decimalString(d(text)), text)
  }
})

test('numberToken reads only the matching original numeric token', () => {
  const raw = '[{"quality":0.100000000000000001,"tiny":1e-400,"string":"0.9","zero":-0,"a/b~c":9e-1}]'
  const source = { raw, ...parseLocatedJson(raw) }
  assert.equal(numberToken(source, '/0/quality', source.value[0].quality), '0.100000000000000001')
  assert.equal(numberToken(source, '/0/tiny', source.value[0].tiny), '1e-400')
  assert.equal(numberToken(source, '/0/zero', source.value[0].zero), '-0')
  assert.equal(numberToken(source, '/0/a~1b~0c', source.value[0]['a/b~c']), '9e-1')
  for (const [pointer, value] of [['/0/string', source.value[0].string], ['/0/string', .9], ['/missing', .9], ['/0/quality', .9], ['/0/zero', 0]]) {
    assert.throws(() => numberToken(source, pointer, value), { code: 'DECIMAL_TOKEN_INVALID' })
  }
  assert.throws(() => numberToken({ raw: '1', locations: new Map([['', { start: -1, end: 1 }]]) }, '', 1), { code: 'DECIMAL_TOKEN_INVALID' })
})
