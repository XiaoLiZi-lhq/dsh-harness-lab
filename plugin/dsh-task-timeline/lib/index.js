/**
 * dsh-task-timeline host half: one prefix route serving the session's task
 * history replayed from its persisted JSONL log.
 *
 * POST /task-timeline/api/history  {sessionId}
 *   -> {ok, current, snapshots, updatedAt}
 *      snapshots: [{seq, time, turn, prompt, todos}] in log order
 *
 * The current task list is the LAST todo_write in the log (the tool replaces
 * the whole list per call), so the tab needs no live projection channel.
 */
import { spawn } from 'node:child_process'
import { existsSync, globSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/** Services required before mounting: the webserver route surface. */
export const inject = ['webServer']

const ZSTD_CANDIDATES = ['/opt/homebrew/bin/zstdcat', '/usr/local/bin/zstdcat', '/usr/bin/zstdcat']
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

function zstdcat() {
  for (const c of ZSTD_CANDIDATES) if (existsSync(c)) return c
  return 'zstdcat'
}

/** A log replay failure — surfaced as a 5xx `replay-failed`, never as empty data. */
function replayFailed(message, cause) {
  return Object.assign(new Error(message), { statusCode: 500, code: 'replay-failed', cause })
}

/**
 * Stream one session log's lines through `feed` as zstdcat decodes them: no
 * full-text buffer, no second parse pass. Resolves ONLY on a clean exit
 * (code 0) — a truncated/corrupt log, a missing zstdcat, or a 20s stall
 * rejects, so partial output can never be handed out as a complete result.
 */
function streamLog(file, feed) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    let timer = null
    const done = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value) } }
    let child
    try {
      child = spawn(zstdcat(), [file], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (e) {
      console.error(`[dsh-task-timeline] spawning zstdcat for ${file} failed:`, e?.message ?? e)
      done(reject, replayFailed('log decompress failed (is zstd installed?)', e))
      return
    }
    timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 20000)
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (line === '') return
      try { feed(line) } catch { /* one malformed line never kills the replay */ }
    })
    child.on('error', (e) => {
      console.error(`[dsh-task-timeline] zstdcat failed for ${file}:`, e?.message ?? e)
      done(reject, replayFailed('log decompress failed (is zstd installed?)', e))
    })
    // 'close' fires only after the stdio streams drained, so every line has
    // been fed by the time we get to inspect the exit code.
    child.on('close', (code) => {
      if (settled) return
      if (code === 0) { done(resolve); return }
      console.error(`[dsh-task-timeline] zstdcat exited with code ${code ?? 'null (killed by signal)'}${timedOut ? ' after the 20s timeout' : ''} for ${file}`)
      done(reject, replayFailed(timedOut ? 'log decompress timed out' : 'log decompress failed (truncated or corrupt log)'))
    })
  })
}

/** Replay todo_write calls with their turn's opening user prompt. */
async function replay(sessionId) {
  if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) {
    throw Object.assign(new Error('bad sessionId'), { statusCode: 400 })
  }
  const hits = globSync(join(SESSIONS_ROOT, '*', sessionId, 'session.jsonl.zstd'))
  if (hits.length === 0) throw Object.assign(new Error('session log not found'), { statusCode: 404 })
  const snapshots = []
  let turn = 0
  let prompt = ''
  const feed = (line) => {
    let o
    try { o = JSON.parse(line) } catch { return }
    const t = o.type
    if (t === 'turn/start') { turn += 1; prompt = '' }
    else if (t === 'user/message') {
      if (prompt === '') {
        const content = o.data?.content
        if (!Array.isArray(content)) return // malformed events degrade, never crash the request
        for (const c of content) {
          if (c?.type === 'text' && typeof c.text === 'string') {
            const s = c.text.trim()
            if (s !== '' && !s.startsWith('<') && !s.startsWith('Current runtime context')) {
              prompt = s.slice(0, 120)
              break
            }
          }
        }
      }
    } else if (t === 'tool/call' && o.data?.name === 'todo_write') {
      let todos = null
      try { todos = JSON.parse(o.data.arguments ?? '{}').todos ?? null } catch { /* keep null */ }
      if (Array.isArray(todos)) {
        snapshots.push({
          seq: o.seq, time: o.time, turn, prompt,
          // `todos` is model output: drop null/primitive entries instead of
          // letting one hallucinated element 500 the whole timeline.
          todos: todos.filter((x) => x !== null && typeof x === 'object')
            .map((x) => ({ content: String(x.content ?? ''), status: x.status === 'in_progress' ? 'in_progress' : x.status === 'completed' ? 'completed' : 'pending' })),
        })
      }
    }
  }
  await streamLog(hits[0], feed)
  const current = snapshots.length > 0 ? snapshots[snapshots.length - 1].todos : []
  return { current, snapshots }
}

/**
 * Same-origin fence: absent Origin passes (same-origin fetch), foreign Origin
 * is refused. Origin==Host alone is DNS-rebinding-spoofable (an attacker
 * domain rebound to 127.0.0.1 sends matching headers), so the origin hostname
 * must additionally be a loopback literal.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
function fence(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === 'null') return typeof origin !== 'string'
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (url.host !== (req.headers?.host ?? '')) return false
    return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    let closed = false
    req.on('data', (d) => {
      if (closed) return
      raw += d
      if (raw.length > 65536) {
        // Destroying the socket also kills the response: reject first so the
        // caller knows why; the route's catch skips writing to the dead res.
        closed = true
        req.destroy()
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
      }
    })
    req.on('end', () => {
      if (closed) return
      try {
        const body = raw === '' ? {} : JSON.parse(raw)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          throw new Error('body must be a JSON object')
        }
        resolve(body)
      } catch {
        reject(Object.assign(new Error('bad json'), { statusCode: 400 }))
      }
    })
    req.on('error', () => {
      if (!closed) reject(Object.assign(new Error('request error'), { statusCode: 400 }))
    })
  })
}

/**
 * Client plugin body: mount the /task-timeline/api prefix route.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/task-timeline/api',
    handler: async (req, res) => {
      if (!fence(req)) return writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      if (req.method !== 'POST' || pathname !== '/task-timeline/api/history') {
        return writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
      }
      try {
        const body = await readBody(req)
        const result = await replay(body.sessionId)
        writeJson(res, 200, { ok: true, ...result, updatedAt: Date.now() })
      } catch (error) {
        // The socket may already be gone (readBody destroys oversized
        // requests) — never write to a dead response.
        if (res.destroyed || res.writableEnded) return
        writeJson(res, error?.statusCode ?? 500, { ok: false, error: { code: error?.code ?? 'error', message: String(error?.message ?? error) } })
      }
    },
  }), 'dsh-task-timeline: /task-timeline/api route')
}
