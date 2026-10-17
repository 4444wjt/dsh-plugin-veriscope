const nullable = type => ({ oneOf: [{ type }, { type: 'null' }] })
export const reportSchema = {
  type: 'object',
  required: ['schema_version', 'run_id', 'status', 'gate_passed', 'exit_code', 'gate_message', 'metrics', 'thresholds', 'evidence', 'judge_provenance', 'limitations', 'execution'],
  properties: {
    schema_version: { type: 'string' }, run_id: { type: 'string' }, status: { type: 'string', enum: ['PASS', 'FAIL', 'REVIEW'] },
    gate_passed: nullable('boolean'), exit_code: nullable('integer'), gate_message: { type: 'string' },
    metrics: { type: 'array', items: { type: 'object' } },
    thresholds: { type: 'object', properties: { faith: nullable('number'), ctx: nullable('number') }, required: ['faith', 'ctx'] },
    evidence: { type: 'array', items: { type: 'object', required: ['source_id', 'kind', 'path', 'sha256', 'locator', 'quote'], properties: { source_id: { type: 'string' }, kind: { type: 'string', enum: ['archive_field', 'replay_stdout', 'original_context_quote'] }, path: { type: 'string' }, sha256: { type: 'string' }, locator: { type: 'object' }, quote: { type: 'string' } } } },
    judge_provenance: { type: 'object' }, limitations: { type: 'array', items: { type: 'string' } }, execution: { type: 'object' },
    archived_gate: nullable('boolean'), historical_trace: { type: 'object' },
  }, additionalProperties: false,
}

// DSH defineTool accepts its value-schema DSL, not raw JSON Schema.
export function toValueSpec(schema) {
  const { required, ...node } = schema
  if (node.type === 'object') {
    node.additionalProperties ??= true
    if (node.properties) node.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, {
      ...toValueSpec(value), ...(required?.includes(key) ? { required: true } : {}),
    }]))
  }
  if (node.items) node.items = toValueSpec(node.items)
  if (node.oneOf) node.oneOf = node.oneOf.map(toValueSpec)
  return node
}
export const reportSchemaSpec = toValueSpec(reportSchema)

export const statusSchema = {
  type: 'object', required: ['schema_version', 'run_id', 'historical_verdict', 'current_verdict', 'gate_passed', 'freshness', 'integrity', 'reason_codes', 'checked_at_utc', 'scope_digest', 'sources', 'next_step', 'limitations', 'elapsed_ms'],
  properties: {
    schema_version: { type: 'string', enum: ['GateStatusV1'] }, run_id: nullable('string'),
    historical_verdict: { type: 'string', enum: ['PASS', 'FAIL', 'REVIEW', 'unknown'] },
    current_verdict: { type: 'string', enum: ['PASS', 'FAIL', 'REVIEW'] }, gate_passed: nullable('boolean'),
    freshness: { type: 'string', enum: ['FRESH', 'STALE', 'UNKNOWN'] }, integrity: { type: 'string', enum: ['VALID', 'INVALID', 'UNKNOWN'] },
    reason_codes: { type: 'array', items: { type: 'string' } }, checked_at_utc: { type: 'string' }, scope_digest: nullable('string'),
    sources: { type: 'array', items: { type: 'object' } }, next_step: { type: 'string' }, limitations: { type: 'array', items: { type: 'string' } }, elapsed_ms: { type: 'number' }, session_id: nullable('string'),
    reason_messages: { type: 'array', items: { type: 'string' } }, details: { oneOf: [{ type: 'object' }, { type: 'null' }] },
  }, additionalProperties: false,
}
export const managedSchema = { type: 'object', required: ['schema_version', 'accepted', 'reason_code', 'status'], properties: {
  schema_version: { type: 'string', enum: ['ManagedGateV1'] }, accepted: { type: 'boolean' }, reason_code: { type: 'string' },
  status: { oneOf: [statusSchema, { type: 'null' }] }, session_id: nullable('string'),
}, additionalProperties: false }
export const statusSchemaSpec = toValueSpec(statusSchema)
export const managedSchemaSpec = toValueSpec(managedSchema)

// Utility results are not gate verdicts. In particular, doctor READY is never PASS.
export const utilitySchemaSpec = { type: 'object', additionalProperties: true, properties: { schema_version: { type: 'string', required: true } } }
