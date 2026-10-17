import { ReviewError } from './errors.js'

export const DECIMAL_LIMITS = Object.freeze({ token_length: 1024, exponent: 1024 })
const numericToken = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/
const invalid = () => { throw new ReviewError('DECIMAL_TOKEN_INVALID', '需要原始 JSON 数值词元和有效十进制参数。') }
const limited = () => { throw new ReviewError('DECIMAL_LIMIT', '十进制词元长度或指数超过支持范围。') }

function matchToken(token) {
  if (typeof token !== 'string') invalid()
  if (token.length > DECIMAL_LIMITS.token_length) limited()
  const match = numericToken.exec(token)
  if (!match || match[0].length !== token.length) invalid()
  return match
}

// A decimal is coefficient * 10^exponent. Only JSON numeric tokens enter here;
// callers must not pass JSON string values as if they were numeric scores.
export function parseDecimalToken(token) {
  const [, sign, integer, fraction = '', rawExponent = '0'] = matchToken(token)
  const exponentDigits = rawExponent.replace(/^[+-]?0*/, '') || '0'
  // Check the written exponent even for zero, before BigInt or powers of ten.
  if (exponentDigits.length > String(DECIMAL_LIMITS.exponent).length) limited()
  const writtenExponent = Number(rawExponent)
  if (!Number.isSafeInteger(writtenExponent) || Math.abs(writtenExponent) > DECIMAL_LIMITS.exponent) limited()
  let digits = (integer + fraction).replace(/^0+/, '')
  if (!digits) return { coefficient: 0n, exponent: 0 }
  const significant = digits.replace(/0+$/, '')
  const exponent = writtenExponent - fraction.length + digits.length - significant.length
  if (Math.abs(exponent) > DECIMAL_LIMITS.exponent) limited()
  digits = significant
  return { coefficient: BigInt(sign + digits), exponent }
}

function decimal(value) {
  if (!value || typeof value.coefficient !== 'bigint' || !Number.isSafeInteger(value.exponent)) invalid()
  // Aggregation retains the input exponent instead of normalizing trailing
  // zeros. Its exponent therefore stays within the same bounded range.
  if (Math.abs(value.exponent) > DECIMAL_LIMITS.exponent) limited()
  return value
}

const power = exponent => 10n ** BigInt(exponent)

export function compareDecimal(a, b) {
  decimal(a); decimal(b)
  const exponent = Math.min(a.exponent, b.exponent)
  const left = a.coefficient * power(a.exponent - exponent)
  const right = b.coefficient * power(b.exponent - exponent)
  return left < right ? -1 : left > right ? 1 : 0
}

export function sumDecimals(values) {
  if (!Array.isArray(values)) invalid()
  let coefficient = 0n, exponent = 0, initialized = false
  for (const value of values) {
    decimal(value)
    if (value.coefficient === 0n) continue
    if (!initialized) {
      coefficient = value.coefficient; exponent = value.exponent; initialized = true
    } else if (value.exponent < exponent) {
      coefficient = coefficient * power(exponent - value.exponent) + value.coefficient
      exponent = value.exponent
    } else coefficient += value.coefficient * power(value.exponent - exponent)
  }
  return coefficient === 0n ? { coefficient: 0n, exponent: 0 } : { coefficient, exponent }
}

// Comparing sum with threshold * count avoids rounded or recurring division.
export function compareMean(sum, count, threshold) {
  decimal(sum); decimal(threshold)
  if (!Number.isSafeInteger(count) || count <= 0) invalid()
  return compareDecimal(sum, { coefficient: threshold.coefficient * BigInt(count), exponent: threshold.exponent })
}

// Canonical exact text: ordinary notation up to 128 characters, scientific
// notation beyond that. Scientific notation retains every significant digit.
export function decimalString(value) {
  decimal(value)
  if (value.coefficient === 0n) return '0'
  const sign = value.coefficient < 0n ? '-' : ''
  const original = (value.coefficient < 0n ? -value.coefficient : value.coefficient).toString()
  const digits = original.replace(/0+$/, '')
  const exponent = value.exponent + original.length - digits.length
  const point = digits.length + exponent
  const plainLength = sign.length + (point <= 0 ? 2 - point + digits.length : point >= digits.length ? point : digits.length + 1)
  if (plainLength <= 128) {
    if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
    if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
  }
  return `${sign}${digits[0]}${digits.length > 1 ? '.' + digits.slice(1) : ''}e${point - 1}`
}

// The location must point at the numeric token corresponding to a parsed
// number. Quoted numeric strings, unrelated locations and absent tokens fail.
export function numberToken(source, pointer, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || typeof source?.raw !== 'string' || typeof source?.locations?.get !== 'function') invalid()
  const location = source.locations.get(pointer)
  if (!location || !Number.isSafeInteger(location.start) || !Number.isSafeInteger(location.end)
    || location.start < 0 || location.end <= location.start || location.end > source.raw.length) invalid()
  const token = source.raw.slice(location.start, location.end)
  matchToken(token)
  if (!Object.is(JSON.parse(token), value)) invalid()
  return token
}
