import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStatusService } from './status.js'
import { storePaths, validRunId } from './receipt.js'

const TASK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/
export function pluginConfiguration(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(k => k !== 'completionMode') || !['off', 'remind'].includes(config.completionMode ?? 'off')) throw new Error('completionMode 仅允许 off 或 remind；不接受未知配置项。')
  return { completionMode: config.completionMode ?? 'off' }
}
export function sessionIdentity(execution) {
  const session = execution?.agent?.session
  return session && typeof session.id === 'string' && session.id.length > 0 ? session.id : null
}
export function createManagedService(options = {}) {
  const statusService = options.statusService ?? createStatusService(options)
  const bindings = new Map(), reminders = new Set(), inFlight = new Set()
  let active = true
  const key = (session, task) => JSON.stringify([session, task])
  const denied = (code, status = null) => ({ schema_version: 'ManagedGateV1', accepted: false, reason_code: code, status })
  const inputs = args => {
    if (!args || typeof args !== 'object' || !TASK.test(args.task_id) || !args.run_id) return false
    try { validRunId(args.run_id); return true } catch { return false }
  }
  return {
    async bind(args, execution) {
      const session = sessionIdentity(execution)
      if (!active || !session || execution?.signal?.aborted) return denied('SESSION_REQUIRED_OR_CANCELLED')
      if (!inputs(args) || Object.keys(args).some(k => !['task_id', 'run_id', 'faith', 'ctx', 'baseline_run_id'].includes(k))) return denied('INVALID_BIND_ARGUMENT')
      const id = key(session, args.task_id)
      if (bindings.has(id)) return denied('TASK_ALREADY_BOUND')
      const { task_id, ...policy } = args
      const status = await statusService.status(policy, { signal: execution.signal })
      if (!active || execution.signal?.aborted) return denied('CANCELLED', status)
      if (status.integrity !== 'VALID' || status.freshness !== 'FRESH') return denied('RECEIPT_NOT_CURRENT', status)
      if (bindings.has(id)) return denied('TASK_ALREADY_BOUND', status)
      if (bindings.size >= 256) return denied('BINDING_LIMIT', status)
      bindings.set(id, { session, task_id, run_id: args.run_id, policy, scope: status.scope_digest, complete: false })
      return { schema_version: 'ManagedGateV1', accepted: true, reason_code: 'BOUND', status }
    },
    async complete(args, execution) {
      const session = sessionIdentity(execution)
      if (!active || !session || execution?.signal?.aborted) return denied('SESSION_REQUIRED_OR_CANCELLED')
      if (!inputs(args) || Object.keys(args).some(k => !['task_id', 'run_id'].includes(k))) return denied('INVALID_COMPLETE_ARGUMENT')
      const id = key(session, args.task_id), binding = bindings.get(id)
      if (!binding || binding.run_id !== args.run_id) return denied('TASK_NOT_BOUND')
      if (binding.complete || inFlight.has(id)) return denied('ALREADY_COMPLETED_OR_IN_FLIGHT')
      inFlight.add(id)
      try {
        const status = await statusService.status(binding.policy, { signal: execution.signal })
        if (!active || execution.signal?.aborted) return denied('CANCELLED', status)
        if (status.current_verdict !== 'PASS' || status.gate_passed !== true || status.freshness !== 'FRESH' || status.integrity !== 'VALID' || status.scope_digest !== binding.scope) return denied('CURRENT_PASS_REQUIRED', status)
        // Commit only after another real check, never after an optimistic client response.
        const final = await statusService.status(binding.policy, { signal: execution.signal })
        if (!active || execution.signal?.aborted || final.current_verdict !== 'PASS' || final.scope_digest !== binding.scope || final.integrity !== 'VALID' || final.freshness !== 'FRESH') return denied('FINAL_CHECK_FAILED', final)
        try {
          const root = storePaths(options, true).stateRoot, directory = path.join(root, 'completions')
          fs.mkdirSync(directory, { recursive: true })
          if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('completion path redirected')
          const filename = path.join(directory, randomUUID() + '.json')
          fs.writeFileSync(filename, JSON.stringify({ schema_version: 'ManagedCompletionV1', session_id: session, task_id: args.task_id, run_id: args.run_id, scope_digest: binding.scope, checked_at_utc: final.checked_at_utc, completed_at_utc: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 })
        } catch { return denied('COMPLETION_WRITE_FAILED', final) }
        binding.complete = true
        return { schema_version: 'ManagedGateV1', accepted: true, reason_code: 'COMPLETED', status: final }
      } finally { inFlight.delete(id) }
    },
    async remind(event) {
      const session = sessionIdentity(event), turn = event?.turn
      if (!active || !session || !Number.isSafeInteger(turn) || turn < 0 || event?.signal?.aborted || typeof event.agent?.steer !== 'function') return false
      const pending = [...bindings.values()].find(b => b.session === session && !b.complete)
      if (!pending) return false
      // One reminder per session/turn AND per bound task/scope prevents steer recursion.
      const turnKey = key(session, `turn:${turn}`), scopeKey = key(session, `${pending.task_id}:${pending.scope}`)
      if (reminders.has(turnKey) || reminders.has(scopeKey) || reminders.size >= 512) return false
      reminders.add(turnKey); reminders.add(scopeKey)
      try {
        event.agent.steer({ id: randomUUID(), role: 'user', source: { kind: 'veriscope-gate-reminder', form: 'notice', summary: `受管任务 ${pending.task_id} 待完成` }, content: [{ type: 'text', text: `受管任务 ${pending.task_id} 尚未完成。请检查当前回执，再调用 veriscope_gate_complete；待复核和失败均不能登记完成。此消息仅为提醒。` }] })
        return true
      } catch { return false }
    },
    dispose() { active = false; bindings.clear(); reminders.clear(); inFlight.clear() },
  }
}
