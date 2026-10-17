// Optional same-origin, read-only status action for the native result card.
export function registerStatusBridge(ctx, statusService, sessionRuns) {
  const server = ctx.get('webServer')
  if (!server?.register) return () => {}
  return server.register({ kind: 'exact', path: '/veriscope/status', async handler(req, res) {
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
    if (req.method !== 'POST') { send(405, { error: '仅支持重新检查' }); return }
    const origin = req.headers.origin, expected = `${server.protocol}//${req.headers.host}`
    let localOrigin = false
    try { localOrigin = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname) } catch {}
    if (!localOrigin || origin !== expected || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { send(403, { error: '来源或请求类型无效' }); return }
    let body = '', size = 0
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 4096) { send(413, { error: '请求过大' }); return } body += chunk.toString('utf8') }
      const args = JSON.parse(body)
      if (!args || Object.keys(args).some(k => !['session_id', 'run_id'].includes(k)) || !sessionRuns.get(args.session_id)?.has(args.run_id)) { send(403, { error: '本会话没有此运行记录，请先调用状态工具' }); return }
      send(200, await statusService.status({ run_id: args.run_id }))
    } catch { if (!res.writableEnded) send(400, { error: '重新检查失败，请使用状态工具' }) }
  } })
}
