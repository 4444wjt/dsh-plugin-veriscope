import { spawn } from 'node:child_process'
import { LIMITS } from './config.js'

export function runBoundedProcess(executable, args, { cwd, signal, timeoutMs = LIMITS.timeoutMs, outputBytes = LIMITS.outputBytes, env = process.env } = {}) {
  return new Promise(resolve => {
    const start = performance.now()
    const chunks = { stdout: [], stderr: [] }
    const lengths = { stdout: 0, stderr: 0 }
    let child, timer, reason = null, error = null, settled = false
    const stop = value => { if (!reason) reason = value; child?.kill() }
    const abort = () => stop('cancelled')
    const done = (code, terminationSignal) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      resolve({
        code, signal: terminationSignal, reason, error,
        stdout: Buffer.concat(chunks.stdout).toString('utf8'), stderr: Buffer.concat(chunks.stderr).toString('utf8'),
        elapsed_ms: performance.now() - start, stdout_bytes: lengths.stdout, stderr_bytes: lengths.stderr,
      })
    }
    if (signal?.aborted) { reason = 'cancelled'; done(null, null); return }
    try {
      child = spawn(executable, args, { cwd, env: { ...env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHON_DOTENV_DISABLED: '1' }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (caught) { reason = 'spawn_error'; error = caught.code ?? 'SPAWN_ERROR'; done(null, null); return }
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', data => {
        const remaining = Math.max(0, outputBytes - lengths[stream])
        if (remaining) chunks[stream].push(data.subarray(0, remaining))
        lengths[stream] += data.length
        if (lengths[stream] > outputBytes) stop('output_limit')
      })
    }
    child.on('error', caught => { error = caught.code ?? 'SPAWN_ERROR'; reason ??= 'spawn_error' })
    child.on('close', (code, terminationSignal) => done(code, terminationSignal))
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => stop('timeout'), timeoutMs)
    timer.unref?.()
  })
}
