window.__ModuleLoader__.load({
  id: 'dsh-plugin-veriscope',
  factory: require => {
    const React = require('react'), h = React.createElement
    const labels = { PASS: '通过', FAIL: '失败', REVIEW: '待复核', unknown: '未知' }
    const css = `.vscope-card{font:15px/1.65 "Microsoft YaHei",system-ui,sans-serif;color:#ede9e0;background:#171918;border:1px solid #53554e;border-radius:14px;padding:24px;margin:12px 0;max-width:740px;overflow-wrap:anywhere}.vscope-card *{box-sizing:border-box}.vscope-card h3{font-size:20px;margin:0 0 8px;font-weight:700}.vscope-card p{margin:8px 0 18px;color:#d8d4c9}.vscope-card .vscope-status{font-size:24px;font-weight:700;display:flex;align-items:center;gap:10px}.vscope-dot{width:9px;height:9px;background:currentColor;border-radius:50%;display:inline-block}.vscope-card button,.vscope-card summary{font:inherit;cursor:pointer}.vscope-card button{border:1px solid #f2c879;background:#f2c879;color:#21211b;border-radius:8px;padding:8px 18px;font-weight:600}.vscope-card button:hover{background:#ffdc9e}.vscope-card button:disabled{opacity:.65;cursor:wait}.vscope-card button:focus-visible,.vscope-card summary:focus-visible{outline:2px solid #f2c879;outline-offset:4px}.vscope-card details{margin-top:20px;border-top:1px solid #53554e;padding-top:14px}.vscope-card summary{color:#f2c879}.vscope-card dl{margin:12px 0}.vscope-card dt{font-weight:600;margin-top:12px}.vscope-card dd{margin:2px 0;color:#d8d4c9}.vscope-card time{display:block;font-size:12px;color:#d8d4c9;margin-top:12px}.vscope-card ::selection{background:#f2c879;color:#171918}`
    function Card({ block }) {
      const meta = block?.meta?.veriscope, runId = meta?.run_id, sessionId = meta?.session_id
      const builtin = ['builtin-threshold-v1', 'builtin-threshold-v2'].includes(meta?.engine_id)
      const policy = meta && Object.hasOwn(meta, 'policy') ? meta.policy : {}
      const validPolicy = policy && typeof policy === 'object' && !Array.isArray(policy) && Object.keys(policy).every(key => ['faith', 'ctx', 'baseline_run_id'].includes(key)) &&
        ['faith', 'ctx'].every(key => !Object.hasOwn(policy, key) || typeof policy[key] === 'number' && Number.isFinite(policy[key]) && policy[key] >= 0 && policy[key] <= 1) &&
        (!Object.hasOwn(policy, 'baseline_run_id') || policy.baseline_run_id === null || typeof policy.baseline_run_id === 'string' && policy.baseline_run_id.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(policy.baseline_run_id))
      const policyKey = validPolicy ? JSON.stringify(policy) : null
      const [value, setValue] = React.useState(null), [loading, setLoading] = React.useState(false), [error, setError] = React.useState('')
      const sequence = React.useRef(0), abort = React.useRef(null)
      const refresh = React.useCallback(async () => {
        const seq = ++sequence.current
        abort.current?.abort(); abort.current = new AbortController()
        setValue(null); setLoading(true); setError('')
        if (builtin) { setLoading(false); return }
        if (!runId || !sessionId) { setError('尚无本会话回执，请先调用状态工具。'); setLoading(false); return }
        if (!validPolicy) { setError('门禁策略不完整，请调用状态工具核实。'); setLoading(false); return }
        try {
          const response = await fetch('/veriscope/status', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: runId, session_id: sessionId, policy: JSON.parse(policyKey) }), signal: abort.current.signal })
          if (!response.ok) throw new Error('状态服务暂不可用，请调用 veriscope_gate_status 重新检查。')
          const next = await response.json()
          if (next.schema_version !== 'GateStatusV1' || next.run_id !== runId || !['PASS', 'FAIL', 'REVIEW'].includes(next.current_verdict) || next.gate_passed !== (next.current_verdict === 'PASS' ? true : next.current_verdict === 'FAIL' ? false : null) || (next.current_verdict !== 'REVIEW' && (next.integrity !== 'VALID' || next.freshness !== 'FRESH'))) throw new Error('状态响应不完整，请使用文本工具核实。')
          if (seq === sequence.current) setValue(next)
        } catch (caught) { if (seq === sequence.current && caught?.name !== 'AbortError') setError('无法确认当前状态，请重试或调用 veriscope_gate_status。') }
        finally { if (seq === sequence.current) setLoading(false) }
      }, [runId, sessionId, policyKey, builtin])
      React.useEffect(() => { refresh(); return () => { ++sequence.current; abort.current?.abort() } }, [refresh])
      const status = value?.current_verdict ?? 'REVIEW'
      const tone = status === 'PASS' ? '#9dd7b7' : status === 'FAIL' ? '#ffb2a9' : '#f2c879'
      const detail = value?.details
      const number = n => typeof n === 'number' && Number.isFinite(n) ? String(n) : '未知'
      const reasons = value?.reason_codes?.map((code, i) => `${value.reason_messages?.[i] || `${code}（未收录）`} [${code}]`).join('；')
      const changes = value?.changes
      const changeValue = item => typeof item === 'string' ? item : typeof item === 'number' && Number.isFinite(item) ? String(item) : '未知'
      const changeItems = Array.isArray(changes?.items) ? changes.items.slice(0, 20) : []
      const changeSummary = changes?.state === 'COMPLETE'
        ? changes.total === 0 ? '已核对的绑定项未变化。' : `已确认 ${number(changes.total)} 项变化${changes.truncated ? '，仅显示前 20 项' : ''}。`
        : `部分或全部绑定项未核实，请结合检查原因处理。${changes?.total > 0 ? `已确认 ${number(changes.total)} 项变化${changes.truncated ? '，仅显示前 20 项' : ''}。` : ''}`
      const inputDiagnostic = meta?.input_diagnostic
      const hasInputDiagnostic = Number.isInteger(inputDiagnostic?.line) && inputDiagnostic.line > 0 && Number.isInteger(inputDiagnostic?.column) && inputDiagnostic.column > 0
      if (builtin) return h('pre', { 'data-veriscope-mode': 'builtin-text', style: {
        font: '15px/1.75 "Microsoft YaHei",system-ui,sans-serif', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        color: '#ede9e0', background: '#171918', borderLeft: '3px solid #F2C879', padding: '16px 20px', margin: '12px 0',
      } }, typeof meta.builtin_text === 'string' ? meta.builtin_text : '请使用文本工具核实独立阈值门禁。')
      return h('section', { className: 'vscope-card', 'aria-label': 'VeriScope 门禁回执', 'data-veriscope-status': status },
        h('style', null, css), h('h3', null, '门禁回执'),
        h('div', { className: 'vscope-status', style: { color: tone }, role: 'status', 'aria-live': 'polite' }, h('span', { className: 'vscope-dot', 'aria-hidden': true }), loading ? '正在检查' : labels[status]),
        h('p', null, error || value?.next_step || '尚未确认当前有效性。'),
        h('button', { type: 'button', onClick: refresh, disabled: loading }, loading ? '检查中…' : '重新检查'),
        h('details', null, h('summary', null, '查看依据'),
          h('dl', null, h('dt', null, '历史裁决'), h('dd', null, labels[value?.historical_verdict ?? meta?.historical_verdict] ?? '未知'),
            ...(hasInputDiagnostic ? [h('dt', { key: 'diagnostic-title' }, '原重放的归档诊断'), h('dd', { key: 'diagnostic-value' }, `${inputDiagnostic.source === 'baseline' ? '基线' : '输入'}归档：第 ${inputDiagnostic.line} 行，第 ${inputDiagnostic.column} 列。按解码后 UTF-16 计数；这是发现点，不一定是唯一修改点。`)] : []),
            h('dt', null, '运行编号'), h('dd', null, runId || '尚无记录'),
            h('dt', null, '检查原因'), h('dd', null, reasons || '尚未完成当前检查'),
            h('dt', null, '回执阈值'), h('dd', null, `Faithfulness ${number(detail?.thresholds?.faith)}；Context Precision ${number(detail?.thresholds?.ctx)}`),
            h('dt', null, '回执绑定环境'), h('dd', null, `Node ${detail?.environment?.node ?? '未知'}；Python ${detail?.environment?.python ?? '未知'}；pandas ${detail?.environment?.pandas ?? '未知'}`),
            h('dt', null, '输入摘要'), h('dd', null, detail?.input?.path ?? '未知'),
            h('dd', null, `${number(detail?.input?.bytes)} 字节；SHA-256 ${typeof detail?.input?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(detail.input.sha256) ? detail.input.sha256.slice(0, 12) : '未知'}`),
            h('dt', null, '绑定项变化'), h('dd', null, changeSummary),
            ...changeItems.map((item, i) => h('dd', { key: `change-${i}` }, `${typeof item?.label === 'string' ? item.label : '绑定项'}：${changeValue(item?.before)} → ${changeValue(item?.after)}`)),
            h('dt', null, '范围摘要'), h('dd', null, value?.scope_digest || '未知')),
          h('p', null, '重新检查只读回执；重新执行门禁请调用重放工具。变化清单不解释分数变化的因果；所列环境是门禁回放环境，不是原评测环境。结果不保证回答事实正确。')),
        value?.checked_at_utc && h('time', { dateTime: value.checked_at_utc }, '检查于 ' + new Date(value.checked_at_utc).toLocaleString('zh-CN')))
    }
    return { inject: ['slots'], apply(ctx) {
      return ctx.slots.inject('tool.call.toolview', function* () {
        for (const key of ['veriscope_gate_replay', 'veriscope_gate_status', 'veriscope_gate_bind', 'veriscope_gate_complete']) yield ctx.slots.register({ name: 'tool.call.toolview', key }, Card)
      })
    } }
  },
})
