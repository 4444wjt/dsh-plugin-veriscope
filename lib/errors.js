// Only fixed archive-schema names may appear in diagnostics. Model names and
// other free-form object keys are never diagnostic pointer segments.
const diagnosticKeys = new Set([
  'result', 'summary', 'model', 'faithfulness', 'context_precision',
  'pos_faithfulness', 'pos_context_precision', 'judge_model',
  'judge_response_models', 'model_dfs', 'gate_passed', 'case_type',
  'contexts', 'hallucination_trace', 'statements', 'evidence',
])
const diagnosticKinds = new Set([
  'syntax', 'unexpected_end', 'invalid_string', 'invalid_escape',
  'invalid_unicode_escape', 'duplicate_key', 'depth_limit',
  'non_finite_number', 'trailing_content', 'structure',
])

export function safeDiagnosticPointer(pointer) {
  if (pointer === '') return ''
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return null
  return pointer.slice(1).split('/').every(segment => diagnosticKeys.has(segment) || /^(?:0|[1-9]\d*)$/.test(segment)) ? pointer : null
}

export class ReviewError extends Error {
  constructor(code, message, diagnostic) {
    super(message)
    this.name = 'ReviewError'
    this.code = code
    if (diagnostic && diagnosticKinds.has(diagnostic.kind)
      && Number.isSafeInteger(diagnostic.offset_utf16) && diagnostic.offset_utf16 >= 0
      && Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0
      && Number.isSafeInteger(diagnostic.column) && diagnostic.column > 0) {
      this.diagnostic = Object.freeze({
        kind: diagnostic.kind,
        offset_utf16: diagnostic.offset_utf16,
        line: diagnostic.line,
        column: diagnostic.column,
        pointer: safeDiagnosticPointer(diagnostic.pointer),
        position_basis: 'decoded_text_utf16',
        location_kind: 'detected',
      })
    }
  }
}

export const issue = (code, message) => ({ code, message })
