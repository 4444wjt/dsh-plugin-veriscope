import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { sha256 } from '../lib/source.js'

export function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veriscope-test-'))
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir())
    assert.ok(path.basename(directory).startsWith('veriscope-test-'))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

export function setup(t, { kind = 'pass', mutate } = {}) {
  const root = temporary(t)
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.writeFileSync(path.join(root, 'scripts/gate_replay.py'), '# local protocol stub, not the upstream implementation\n')
  const contract = { files: { 'scripts/gate_replay.py': sha256(fs.readFileSync(path.join(root, 'scripts/gate_replay.py'))) } }
  const fixture = kind === 'fail' ? '20261005T144504Z-full-39511424' : '20261014T073859Z-full-1c6f091f'
  const summary = kind === 'fail'
    ? { model: 'deepseek-chat', faithfulness: 0.59, context_precision: 0.8667, pos_faithfulness: 0.7375, pos_context_precision: 0.9833 }
    : { model: 'deepseek-chat', faithfulness: 0.6886, context_precision: 0.7867, pos_faithfulness: 0.8607, pos_context_precision: 0.9833 }
  const value = { summary: [summary], gate_passed: kind !== 'fail', model_dfs: { 'deepseek-chat': [{ case_type: 'positive', question: '构造协议样例', answer: '回答', contexts: ['原文'] }] } }
  mutate?.(value)
  const input = path.join(root, '归档 空格 & $().json')
  fs.writeFileSync(input, JSON.stringify(value, null, 2))
  const output = fs.readFileSync(new URL(`./fixtures/${fixture}.stdout.txt`, import.meta.url), 'utf8')
  const calls = []
  const processResult = { code: kind === 'fail' ? 1 : 0, signal: null, reason: null, error: null, stdout: output, stderr: '', elapsed_ms: 1, stdout_bytes: Buffer.byteLength(output), stderr_bytes: 0 }
  const runner = async (executable, args, options) => {
    calls.push({ executable, args, options })
    if (args.includes('-c')) return { ...processResult, code: 0, stdout: JSON.stringify({ version: 'mock', pandas: 'mock', executable }) }
    return { ...processResult }
  }
  return { root, input, value, contract, calls, runner, processResult, options: { env: { VERISCOPE_ROOT: root, VERISCOPE_PYTHON: process.execPath }, contract, runner, artifactsDir: path.join(root, 'runs') } }
}
