import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_WINDOWS_ROOT, resolveConfiguration, resolveRootConfiguration } from './config.js'
import { loadContractProfiles, selectContract } from './contracts.js'
import { probeEnvironment, storePaths } from './receipt.js'
import { scanRuns, recordError } from './catalog.js'
import { createStatusService } from './status.js'
import { reasonMessage } from './reasons.js'

const ps = value => "'" + String(value).replaceAll("'", "''") + "'"
const sh = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
const assignment = (key, value, platform) => platform === 'win32' ? `$env:${key} = ${ps(value)}` : `export ${key}=${sh(value)}`
const restart = '# 替换为实际存在的路径，然后在同一环境完全重启宿主。'
export function createDoctorService(options = {}) {
  const env = options.env ?? process.env, platform = options.platform ?? process.platform
  const rootHint = typeof env.VERISCOPE_ROOT === 'string' && env.VERISCOPE_ROOT.trim() ? env.VERISCOPE_ROOT : (platform === 'win32' ? DEFAULT_WINDOWS_ROOT : '/path/to/VeriScope')
  const pythonHint = path.join(rootHint, 'venv', ...(platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']))
  return { async doctor(args = {}, { signal } = {}) {
    const value = { schema_version: 'DoctorV1', status: 'REVIEW', ready: false, summary: '环境待复核', items: [], environment: null, state: null, contract: null, new_evaluation_model_calls: 0 }
    const add = (check, status, message, suggestion = null, code = null) => value.items.push({ check, status, message, suggestion, reason_code: code, reason_message: code ? reasonMessage(code) : null })
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) { add('arguments', 'fail', reasonMessage('INVALID_ARGUMENT'), null, 'INVALID_ARGUMENT'); return value }
    let config, profiles, root
    try {
      if (signal?.aborted) throw Object.assign(new Error(), { code: 'CANCELLED' })
      root = resolveRootConfiguration(env, { platform }).veriscopeRoot
      fs.accessSync(root, fs.constants.R_OK)
      add('root_readable', 'ok', 'VeriScope 根目录存在且可读。')
    } catch (error) { root = null; add('root_readable', 'fail', error.message || 'VeriScope 根目录不存在、不可读或不是绝对路径。', `${assignment('VERISCOPE_ROOT', rootHint, platform)}\n${restart}`, error.code ?? 'INVALID_CONFIGURATION') }
    try {
      if (!signal?.aborted) config = resolveConfiguration(env, { platform })
    } catch (error) { add('configuration', 'fail', error.message, `${assignment('VERISCOPE_PYTHON', pythonHint, platform)}\n${restart}`, error.code ?? 'INVALID_CONFIGURATION') }
    try {
      profiles = loadContractProfiles(options)
      add('contract', 'ok', `已加载 ${profiles.length} 套经过审阅的完整执行器契约；每套 ${Object.keys(profiles[0].files).length} 个固定文件摘要。`)
    } catch { profiles = null; add('contract', 'fail', reasonMessage('CONTRACT_INVALID'), '# 从可信的插件版本重新安装；不要手改契约摘要。', 'CONTRACT_INVALID') }
    if (root && profiles) {
      try {
        const selected = selectContract(root, options)
        value.contract = { id: selected.contractId, files: selected.files }
        add('gate_script', 'ok', `门禁重放脚本及全部上游文件完整匹配契约 ${selected.contractId}。`)
      } catch (error) {
        const command = platform === 'win32' ? `Get-FileHash -Algorithm SHA256 -LiteralPath ${ps(path.join(root, 'scripts', 'gate_replay.py'))}` : `sha256sum -- ${sh(path.join(root, 'scripts', 'gate_replay.py'))}`
        add('gate_script', 'fail', error.message, `${command}\n# 核对兼容版本，不要更新摘要来绕过检查。`, error.code ?? 'CONTRACT_MISMATCH')
      }
    } else add('gate_script', 'fail', '配置或契约未通过，无法核实脚本。', '# 先修复上面的配置与契约项。', 'CONTRACT_MISMATCH')
    if (config) {
      try {
        value.environment = await probeEnvironment(config, options, signal)
        add('python', 'ok', `Python ${value.environment.python.version} 可执行，实际解释器路径匹配。`)
        add('pandas', 'ok', `pandas ${value.environment.pandas.version} 可导入，发行元数据完整。`)
      } catch { add('python_pandas', 'fail', reasonMessage('PYTHON_UNAVAILABLE'), `${platform === 'win32' ? '& ' : ''}${platform === 'win32' ? ps(config.pythonPath) : sh(config.pythonPath)} -B -c 'import sys,pandas; print(sys.version); print(pandas.__version__)'\n# 使用上游已验证的环境；不要回退全局 Python。`, 'PYTHON_UNAVAILABLE') }
    } else add('python_pandas', 'fail', '解释器路径无效，未执行环境探测。', `${assignment('VERISCOPE_PYTHON', pythonHint, platform)}\n${restart}`, 'PYTHON_UNAVAILABLE')
    let probe
    try {
      if (signal?.aborted) throw Object.assign(new Error(), { code: 'CANCELLED' })
      const { stateRoot, source } = storePaths(options, true)
      value.state = { root: stateRoot, source }
      probe = path.join(stateRoot, `.doctor-${randomUUID()}.tmp`)
      fs.writeFileSync(probe, 'write-check', { flag: 'wx', mode: 0o600 }); fs.unlinkSync(probe); probe = null
      add('state_writable', 'ok', `状态根可写（来源：${source}）；临时体检文件已清理。`)
    } catch (error) { add('state_writable', 'fail', reasonMessage(error.code === 'INVALID_STATE_DIR' ? error.code : 'STATE_WRITE_FAILED'), `${assignment('VERISCOPE_STATE_DIR', platform === 'win32' ? path.join(env.LOCALAPPDATA ?? 'C:\\Users\\<user>\\AppData\\Local', 'VeriScope', 'state') : path.join(env.XDG_STATE_HOME ?? path.join(env.HOME ?? '/home/<user>', '.local', 'state'), 'veriscope'), platform)}\n# 使用持久目录；在同一环境完全重启宿主。`, error.code === 'INVALID_STATE_DIR' ? error.code : 'STATE_WRITE_FAILED') }
    finally { if (probe) { try { fs.unlinkSync(probe) } catch {} } }
    try {
      const scan = scanRuns(options, signal), recent = scan.rows[0]
      if (scan.truncated) add('recent_receipt', 'fail', reasonMessage('SCAN_LIMIT'), '# 缩小状态根后重新检查；不要删除失败记录。', 'SCAN_LIMIT')
      else if (!recent) add('recent_receipt', 'ok', '尚无历史回执；环境体检不替代首次门禁重放。')
      else {
        const current = recent.reason_codes.length ? null : await (options.statusService ?? createStatusService(options)).status({ run_id: recent.run_id }, { signal })
        if (!current || current.integrity !== 'VALID') add('recent_receipt', 'fail', '最近回执缺失、损坏或不可验证。', '# 保留原记录，修复来源与权限后查询；需要新回执时重新重放。', recent.reason_codes[0] ?? current?.reason_codes[0] ?? 'RECEIPT_INVALID')
        else if (current.freshness !== 'FRESH') add('recent_receipt', 'warn', '最近回执完整，但当前绑定项已变化或无法确认。', '# 检查状态工具列出的原因；需要复用时重新重放。', current.reason_codes[0])
        else add('recent_receipt', 'ok', '最近回执完整；其门禁裁决另看状态工具，不等同环境就绪。')
      }
    } catch (error) { add('recent_receipt', 'fail', '最近回执检查未完成。', '# 核对状态目录权限后重新体检。', recordError(error)) }
    value.ready = value.items.every(i => i.status === 'ok')
    value.status = value.ready ? 'READY' : 'REVIEW'; value.summary = value.ready ? '环境就绪' : '环境待复核'
    return value
  } }
}
export function renderDoctor(value) {
  const names = { ok: '正常', warn: '提醒', fail: '异常' }
  return [value.summary, ...value.items.map(i => `${names[i.status]}：${i.message}${i.reason_code ? ` [${i.reason_code}]` : ''}${i.suggestion ? '\n修复建议：\n' + i.suggestion : ''}`), '环境就绪不是门禁通过；体检不调用评测模型，不自动安装依赖或修改配置。'].join('\n')
}
