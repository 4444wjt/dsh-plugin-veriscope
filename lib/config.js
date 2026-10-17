import fs from 'node:fs'
import path from 'node:path'
import { ReviewError } from './errors.js'

export const LIMITS = Object.freeze({ inputBytes: 10 * 1024 * 1024, outputBytes: 2 * 1024 * 1024, timeoutMs: 120_000 })
export const DEFAULT_WINDOWS_ROOT = 'D:\\RAG_Evaluation_Demo'

function explicit(env, key) {
  if (!Object.hasOwn(env, key)) return undefined
  const value = env[key]
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) || value.includes('\0')) {
    throw new ReviewError('INVALID_CONFIGURATION', `${key} 必须是非空绝对路径。`)
  }
  return value
}

function requirePath(value, kind, label, preservePath = false) {
  try {
    const stat = fs.statSync(value)
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new Error('type')
    // POSIX venv interpreters are symlinks. Executing the resolved binary loses
    // pyvenv.cfg and therefore the selected environment's installed packages.
    return preservePath ? path.resolve(value) : fs.realpathSync(value)
  } catch {
    throw new ReviewError('INVALID_CONFIGURATION', `${label} 不存在或类型不符：${value}`)
  }
}

export function resolveRootConfiguration(env = process.env, { platform = process.platform } = {}) {
  const rootOverride = explicit(env, 'VERISCOPE_ROOT')
  if (rootOverride === undefined && platform !== 'win32') throw new ReviewError('INVALID_CONFIGURATION', '非 Windows 平台必须显式设置 VERISCOPE_ROOT 为 VeriScope 根目录的绝对路径。')
  const veriscopeRoot = requirePath(rootOverride ?? DEFAULT_WINDOWS_ROOT, 'directory', 'VeriScope 根目录')
  const scriptPath = requirePath(path.join(veriscopeRoot, 'scripts', 'gate_replay.py'), 'file', '门禁重放脚本')
  return Object.freeze({ veriscopeRoot, scriptPath, source: rootOverride === undefined ? 'default' : 'environment' })
}

export function resolveConfiguration(env = process.env, { platform = process.platform } = {}) {
  const { veriscopeRoot, scriptPath, source } = resolveRootConfiguration(env, { platform })
  const pythonOverride = explicit(env, 'VERISCOPE_PYTHON')
  let pythonPath = pythonOverride
  if (pythonPath === undefined) {
    const suffix = platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
    pythonPath = ['.venv', 'venv'].map(name => path.join(veriscopeRoot, name, ...suffix))
      .find(candidate => { try { return fs.statSync(candidate).isFile() } catch { return false } })
    if (!pythonPath) throw new ReviewError('PYTHON_NOT_FOUND', '未找到项目 venv Python；请设置 VERISCOPE_PYTHON，禁止回退全局 PATH。')
  }
  pythonPath = requirePath(pythonPath, 'file', 'Python 解释器', true)
  return Object.freeze({
    veriscopeRoot, pythonPath, scriptPath,
    sources: { veriscopeRoot: source, pythonPath: pythonOverride === undefined ? 'venv_probe' : 'environment' },
  })
}

export function validateArguments(args, root) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ReviewError('INVALID_ARGUMENT', '参数必须是对象。')
  for (const key of Object.keys(args)) {
    if (!['result_path', 'baseline', 'faith', 'ctx'].includes(key)) throw new ReviewError('INVALID_ARGUMENT', `不支持的参数：${key}`)
  }
  const result = {}
  for (const key of ['result_path', 'baseline']) {
    const value = args[key]
    if (key === 'baseline' && value === undefined) continue
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new ReviewError('INVALID_ARGUMENT', `${key} 必须是非空文件路径。`)
    result[key] = path.resolve(root, value)
  }
  for (const key of ['faith', 'ctx']) {
    const value = args[key] === undefined ? 0.8 : args[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new ReviewError('INVALID_ARGUMENT', `${key} 必须是 0–1 的有限数值。`)
    result[key] = value
  }
  return result
}
