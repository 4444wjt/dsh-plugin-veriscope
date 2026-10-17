import fs from 'node:fs'
import path from 'node:path'
import { ReviewError } from './errors.js'

export const LIMITS = Object.freeze({ inputBytes: 10 * 1024 * 1024, outputBytes: 2 * 1024 * 1024, timeoutMs: 120_000 })

function explicit(env, key) {
  if (!Object.hasOwn(env, key)) return undefined
  const value = env[key]
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new ReviewError('INVALID_CONFIGURATION', `${key} 必须是非空绝对路径。`)
  }
  return value
}

function requirePath(value, kind, label) {
  try {
    const stat = fs.statSync(value)
    if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new Error('type')
    return fs.realpathSync(value)
  } catch {
    throw new ReviewError('INVALID_CONFIGURATION', `${label} 不存在或类型不符：${value}`)
  }
}

export function resolveConfiguration(env = process.env) {
  const rootOverride = explicit(env, 'VERISCOPE_ROOT')
  const pythonOverride = explicit(env, 'VERISCOPE_PYTHON')
  const veriscopeRoot = requirePath(rootOverride ?? 'D:\\RAG_Evaluation_Demo', 'directory', 'VeriScope 根目录')
  const scriptPath = requirePath(path.join(veriscopeRoot, 'scripts', 'gate_replay.py'), 'file', '门禁重放脚本')
  let pythonPath = pythonOverride
  if (pythonPath === undefined) {
    pythonPath = ['.venv', 'venv'].map(name => path.join(veriscopeRoot, name, 'Scripts', 'python.exe'))
      .find(candidate => { try { return fs.statSync(candidate).isFile() } catch { return false } })
    if (!pythonPath) throw new ReviewError('PYTHON_NOT_FOUND', '未找到项目 venv Python；请设置 VERISCOPE_PYTHON，禁止回退全局 PATH。')
  }
  pythonPath = requirePath(pythonPath, 'file', 'Python 解释器')
  return Object.freeze({
    veriscopeRoot, pythonPath, scriptPath,
    sources: { veriscopeRoot: rootOverride === undefined ? 'default' : 'environment', pythonPath: pythonOverride === undefined ? 'venv_probe' : 'environment' },
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
