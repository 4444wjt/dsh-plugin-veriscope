import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { resolveConfiguration, validateArguments, LIMITS } from './config.js'
import { ReviewError, issue } from './errors.js'
import { readArchive, sha256, sourceEvidence, verifyEvidence, verifyContract } from './source.js'
import { runBoundedProcess } from './process.js'
import { parseReplayOutput, decideStatus } from './parser.js'
import { describeHistoricalTrace } from './trace.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
export const LIMITATIONS = Object.freeze([
  'PASS 仅表示归档指标在本次脚本与阈值下通过门禁，不保证每条回答真实。',
  '本工具不重新计算指标、不新增逐句核查或评测模型调用；宿主对话仍可能产生 token 成本。',
  '归档字段和重放输出属于结果来源证据，不是业务事实已获验证的证明。',
  '历史 Trace 是原 AI 判定，逐字匹配仅为机械约束，不证明语义支持或裁判独立性。',
])

function metricRows(archive) {
  return archive.result.summary.map((entry, index) => ({
    model: typeof entry.model === 'string' ? entry.model : null, primary: index === archive.primaryIndex,
    faithfulness: entry.faithfulness ?? null, context_precision: entry.context_precision ?? null,
    pos_faithfulness: entry.pos_faithfulness ?? null, pos_context_precision: entry.pos_context_precision ?? null,
    source: 'archived_summary',
  }))
}

function judgeProvenance(archive) {
  const model = archive.primary
  const judge = typeof model?.judge_model === 'string' ? model.judge_model : null
  return {
    source: 'archived', generator_model: model?.model ?? null, judge_model: judge,
    response_models: Array.isArray(model?.judge_response_models) ? model.judge_response_models.filter(item => typeof item === 'string') : [],
    model_relation: !judge ? 'unknown' : judge === model.model ? 'same' : 'different',
    route_relation: 'unknown', independence: 'not_established', replay_is_new_judge: false,
    reason: judge ? '模型身份来自归档；缺少路线配置与独立性实验，不推断统计独立。' : '归档 summary 未记录裁判身份，不用当前配置或生成模型补填。',
  }
}

function completenessIssues(archive) {
  const result = []
  if (!archive.primary) return [issue('NO_VALID_MODEL', '归档没有有效主评测模型。')]
  if (['pos_faithfulness', 'pos_context_precision'].some(key => archive.primary[key] === null || archive.primary[key] === undefined)) result.push(issue('MISSING_POSITIVE_METRICS', '正向指标缺失，不能通过。'))
  const rows = archive.result.model_dfs?.[archive.primary.model]
  if (!Array.isArray(rows) || !rows.some(row => row?.case_type === 'positive')) result.push(issue('POSITIVE_CONTEXT_UNVERIFIED', '缺少明确 positive 样本记录，无法确认正向口径；不重算或猜测均值。'))
  return result
}

function cleanTemporaryDirectory(directory) {
  if (!directory) return
  const relative = path.relative(os.tmpdir(), directory)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('veriscope-replay-')) return
  for (const name of ['input.json', 'baseline.json']) {
    try { fs.unlinkSync(path.join(directory, name)) } catch (error) { if (error.code !== 'ENOENT') return }
  }
  try { fs.rmdirSync(directory) } catch { /* an unknown file prevents recursive deletion */ }
}

export function createReplayService(options = {}) {
  const runner = options.runner ?? runBoundedProcess
  const artifactsDir = options.artifactsDir ?? path.join(PACKAGE_ROOT, '.local', 'runs')
  const env = options.env ?? process.env
  let config, configError, contract
  try {
    config = resolveConfiguration(env)
    contract = options.contract ?? JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'contracts', 'upstream.json'), 'utf8'))
  } catch (error) { configError = error }
  return {
    configuration: config ?? null,
    async replay(args, { signal } = {}) {
      const report = {
        schema_version: '1.0', run_id: randomUUID(), status: 'REVIEW', gate_passed: null, exit_code: null,
        gate_message: '待复核：尚未获得完整裁决。', metrics: [], thresholds: { faith: null, ctx: null }, evidence: [],
        judge_provenance: { source: 'unknown', judge_model: null, route_relation: 'unknown', independence: 'not_established', replay_is_new_judge: false },
        limitations: [...LIMITATIONS], archived_gate: null, historical_trace: { status: 'not_available', rejudged: false, rows: [] },
        execution: {
          started_at_utc: new Date().toISOString(), elapsed_ms: null, configuration: config ?? null, errors: [],
          new_evaluation_model_calls: 0, raw_stdout_path: null, raw_stderr_path: null,
          script_files: null, python: null, command: null, artifacts_path: null, process: null,
        },
      }
      const started = performance.now()
      let directory, temporary, archive, baseline, processResult, parsed, input
      try {
        directory = path.join(artifactsDir, report.run_id)
        fs.mkdirSync(directory, { recursive: true })
        report.execution.artifacts_path = directory
        if (configError) throw configError
        input = validateArguments(args, config.veriscopeRoot)
        report.thresholds = { faith: input.faith, ctx: input.ctx }
        report.execution.script_files = verifyContract(config.veriscopeRoot, contract)
        archive = readArchive(input.result_path, LIMITS.inputBytes)
        if (input.baseline) baseline = readArchive(input.baseline, LIMITS.inputBytes)
        report.metrics = metricRows(archive)
        report.archived_gate = typeof archive.result.gate_passed === 'boolean' ? archive.result.gate_passed : null
        report.judge_provenance = judgeProvenance(archive)
        report.historical_trace = describeHistoricalTrace(archive)
        report.execution.input = { path: archive.path, sha256: archive.sha256, bytes: archive.bytes.length }
        report.execution.baseline = baseline ? { path: baseline.path, sha256: baseline.sha256, bytes: baseline.bytes.length } : null
        report.execution.errors.push(...completenessIssues(archive))
        if (baseline) report.execution.errors.push(...completenessIssues(baseline).map(item => issue(`BASELINE_${item.code}`, item.message)))
        if (archive.primary) {
          for (const key of ['model', 'faithfulness', 'context_precision', 'pos_faithfulness', 'pos_context_precision', 'judge_model']) {
            const pointer = `${archive.prefix}/summary/${archive.primaryIndex}/${key}`
            if (archive.locations.has(pointer)) report.evidence.push(sourceEvidence(archive, pointer, 'result'))
          }
        }
        if (archive.locations.has(`${archive.prefix}/gate_passed`)) report.evidence.push(sourceEvidence(archive, `${archive.prefix}/gate_passed`, 'result'))
        if (report.evidence.some(item => !verifyEvidence(item, archive))) throw new ReviewError('INVALID_ANCHOR', '归档证据的哈希或逐字位置校验失败。')
        const probe = await runner(config.pythonPath, ['-B', '-c', 'import json,sys,pandas; print(json.dumps({"version":sys.version.split()[0],"pandas":pandas.__version__,"executable":sys.executable}))'], { cwd: config.veriscopeRoot, signal, timeoutMs: 10_000, outputBytes: 16_384, env })
        if (probe.reason || probe.error || probe.code !== 0) throw new ReviewError('PYTHON_UNAVAILABLE', `Python 或 pandas 不可用（${probe.reason ?? probe.error ?? probe.code}）；请显式配置可用环境。`)
        try {
          report.execution.python = JSON.parse(probe.stdout)
          if (!['version', 'pandas', 'executable'].every(key => typeof report.execution.python[key] === 'string' && report.execution.python[key].length > 0)) throw new Error('missing fields')
        } catch { throw new ReviewError('PYTHON_PROBE_OUTPUT', '无法校验 Python 环境信息。') }
        temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'veriscope-replay-'))
        const snapshot = path.join(temporary, 'input.json')
        fs.writeFileSync(snapshot, archive.bytes, { flag: 'wx', mode: 0o600 })
        const commandArgs = ['-B', config.scriptPath, snapshot, '--faith', String(input.faith), '--ctx', String(input.ctx)]
        if (baseline) {
          const baselineSnapshot = path.join(temporary, 'baseline.json')
          fs.writeFileSync(baselineSnapshot, baseline.bytes, { flag: 'wx', mode: 0o600 })
          commandArgs.push('--baseline', baselineSnapshot)
        }
        report.execution.command = { executable: config.pythonPath, args: commandArgs, cwd: config.veriscopeRoot, shell: false }
        processResult = await runner(config.pythonPath, commandArgs, { cwd: config.veriscopeRoot, signal, timeoutMs: LIMITS.timeoutMs, outputBytes: LIMITS.outputBytes, env })
        report.exit_code = processResult.code
        report.execution.process = { reason: processResult.reason, error: processResult.error, signal: processResult.signal, elapsed_ms: processResult.elapsed_ms, stdout_bytes: processResult.stdout_bytes, stderr_bytes: processResult.stderr_bytes }
        parsed = parseReplayOutput(processResult.stdout, archive, Boolean(baseline))
        report.execution.errors.push(...parsed.errors)
        if (processResult.reason || processResult.error || processResult.signal) report.execution.errors.push(issue('PROCESS_INCOMPLETE', `执行未正常完成：${processResult.reason ?? processResult.error ?? processResult.signal}`))
        if (![0, 1, 2].includes(processResult.code)) report.execution.errors.push(issue('UNKNOWN_EXIT', '退出码不属于已核验契约。'))
        if (processResult.code === 2) report.execution.errors.push(issue('UPSTREAM_INVALID_INPUT', '上游拒绝输入，退出码 2。'))
        if (processResult.code === 0 && parsed.gate !== true) report.execution.errors.push(issue('EXIT_OUTPUT_CONFLICT', '退出码 0 与裁决文本冲突。'))
        if (processResult.code === 1 && !parsed.confirmedFailure) report.execution.errors.push(issue('EXIT_OUTPUT_CONFLICT', '退出码 1 缺少可靠的拦截标记；可能是 Python 异常，保留待复核。'))
        if (processResult.stderr.trim()) report.execution.errors.push(issue('UPSTREAM_STDERR', '上游产生 stderr，请查看原始日志；不自动放行。'))
        for (const source of [archive, baseline].filter(Boolean)) {
          try { if (sha256(fs.readFileSync(source.path)) !== source.sha256) report.execution.errors.push(issue('SOURCE_CHANGED', '运行期间原归档发生变化；本次使用先前字节快照。')) }
          catch { report.execution.errors.push(issue('SOURCE_CHANGED', '运行后原归档不可读。')) }
        }
        try { verifyContract(config.veriscopeRoot, contract) } catch (error) { report.execution.errors.push(issue(error.code, error.message)) }
        for (const [stream, key] of [['stdout', 'raw_stdout_path'], ['stderr', 'raw_stderr_path']]) {
          const filename = path.join(directory, `${stream}.txt`)
          fs.writeFileSync(filename, processResult[stream], { flag: 'wx' })
          report.execution[key] = filename
        }
        if (parsed.gateLine) report.evidence.push({ source_id: 'replay_stdout', kind: 'replay_stdout', path: report.execution.raw_stdout_path, sha256: sha256(processResult.stdout), locator: { line: parsed.gateLine.index + 1 }, quote: parsed.gateLine.line })
      } catch (error) {
        report.execution.errors.push(issue(error.code ?? 'EXECUTION_ERROR', error instanceof ReviewError ? error.message : '本地执行或记录失败，请核查配置、路径和权限。'))
      } finally { cleanTemporaryDirectory(temporary) }
      if (processResult) report.status = decideStatus(processResult, parsed, report.execution.errors)
      report.gate_passed = report.status === 'PASS' ? true : report.status === 'FAIL' ? false : null
      report.gate_message = report.status === 'PASS' ? '通过：Python 重放通过，输入、来源及输出契约校验完整。'
        : report.status === 'FAIL' ? '失败：已核验 Python 退出码及拦截标记确认门禁拦截；附加异常不能覆盖此 FAIL。'
          : `待复核：${report.execution.errors[0]?.message ?? '裁决证据不足。'}`
      if (report.archived_gate !== null && report.gate_passed !== null && report.archived_gate !== report.gate_passed) report.limitations.push('归档结论与本次重放不同；本次显式阈值及脚本版本已记录，未改写旧结论。')
      report.execution.elapsed_ms = performance.now() - started
      if (directory) {
        try { fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }) }
        catch {
          report.execution.errors.push(issue('ARTIFACT_WRITE_ERROR', '验收留痕写入失败。'))
          if (report.status !== 'FAIL') { report.status = 'REVIEW'; report.gate_passed = null; report.gate_message = '待复核：验收留痕写入失败。' }
        }
      }
      return report
    },
  }
}

export function renderReport(report) {
  const labels = { PASS: '通过', FAIL: '失败', REVIEW: '待复核' }
  const primary = report.metrics.find(row => row.primary)
  return [
    `状态：${labels[report.status]}（${report.status}）`, report.gate_message,
    `指标：正向 Faithfulness ${primary?.pos_faithfulness ?? '缺失'}；正向 Context Precision ${primary?.pos_context_precision ?? '缺失'}。`,
    `阈值：${report.thresholds.faith ?? '未确定'} / ${report.thresholds.ctx ?? '未确定'}；Python 退出码：${report.exit_code ?? '无'}。`,
    `出处：${report.evidence.length} 项；记录：${report.execution.artifacts_path ?? '未能写入'}。`,
    ...report.execution.errors.map(item => `需核查 [${item.code}]：${item.message}`), ...report.limitations.map(item => `限制：${item}`),
  ].join('\n')
}
