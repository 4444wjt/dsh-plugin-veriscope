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
function toValueSpec(schema) {
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
