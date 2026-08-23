#!/usr/bin/env node
/**
 * 重启后的活实例一键验证（只读，不写 settings）：
 *  1. apply 诊断日志（apply-enter → webServer-ok → route-registered）；
 *  2. RPC meta.routes / caps.get(openrouter) 通路；
 *  3. 浏览器 bundle 服务状态。
 * 用法：node scripts/verify-live.mjs [baseUrl]（默认 $DSH_WEB_URL / 127.0.0.1:52221）
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { request as httpRequest } from 'node:http'

const base = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:52221'
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const failures = []
const ok = label => console.log(`✔ ${label}`)
const bad = (label, detail) => {
  failures.push(label)
  console.error(`✘ ${label}: ${detail}`)
}

/** 用 node:http 发请求（避免 undici 在 Windows 退出时的 libuv 断言噪音）。 */
function rawFetch(url, options) {
  const { headers = {}, body = '', timeoutMs = 15000 } = options
  const target = new URL(url)
  const payload = Buffer.from(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? 'GET',
      headers: {
        ...headers,
        'content-length': payload.byteLength,
        connection: 'close',
      },
      timeout: timeoutMs,
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, text })
      })
    })
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)))
    req.on('error', reject)
    req.end(payload)
  })
}

// 1. 诊断日志
const logPath = join(dshHome, 'dsh-model-toggles.apply.log')
if (existsSync(logPath)) {
  const lines = readFileSync(logPath, 'utf8').trim().split(/\r?\n/)
  for (const line of lines.slice(-6)) console.log(`  [log] ${line}`)
  const text = lines.join(' ')
  if (text.includes('route-registered')) ok('apply 诊断：路由已注册')
  else if (text.includes('no-webServer')) bad('apply 诊断', 'webServer 不可用（inject 未就绪）——需要看代码')
  else bad('apply 诊断', '未走到 route-registered，见上方日志')
} else {
  bad('apply 诊断', `日志不存在（${logPath}）——DSH 可能还没重启过，或插件行未装载`)
}

async function rpc(method, args = {}) {
  const res = await rawFetch(`${base}/dsh-model-toggles/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-model-toggles': '1' },
    body: JSON.stringify({ method, ...args }),
  })
  let body = null
  try { body = JSON.parse(res.text) } catch { /* 非 JSON 响应 */ }
  return { status: res.status, body }
}

// 2. RPC meta.routes
try {
  const meta = await rpc('meta.routes')
  if (meta.status !== 200 || meta.body?.ok !== true) bad('meta.routes', `status=${meta.status} body=${JSON.stringify(meta.body)}`)
  else {
    ok(`meta.routes：${(meta.body.routes ?? []).length} 条路由（${meta.body.routes.map(r => r.provider).join(', ')}）`)
    // 3. caps.get：挑一个有 models 的路由（openrouter 优先，否则第一条）。
    const target = meta.body.routes.find(r => r.provider === 'openrouter') ?? meta.body.routes[0]
    if (target === undefined) {
      bad('caps.get', '没有任何路由')
    } else {
      const caps = await rpc('caps.get', { route: target.provider })
      if (caps.status !== 200 || caps.body?.ok !== true) bad('caps.get', `status=${caps.status} body=${JSON.stringify(caps.body)}`)
      else {
        const count = Object.keys(caps.body.models ?? {}).length
        ok(`caps.get(${target.provider})：${count} 个模型条目可读`)
      }
    }
  }
} catch (error) {
  bad('RPC 通路', error.message)
}

// 4. 浏览器 bundle
try {
  const bundle = await rawFetch(`${base}/plugins/dsh-model-toggles/client.js`, { timeoutMs: 10000 })
  const head = bundle.text.slice(0, 60)
  if (bundle.status === 200 && head.includes('__ModuleLoader__')) ok('浏览器 bundle 已在服务')
  else bad('浏览器 bundle', `status=${bundle.status}`)
} catch (error) {
  bad('浏览器 bundle', error.message)
}

console.log(failures.length === 0 ? '\n全部通过：刷新页面 → 设置 → 模型 → 编辑提供方 → 展开模型条目，应能看到「图片输入 + 思考强度」勾选。' : `\n${failures.length} 项未通过`)
process.exit(failures.length === 0 ? 0 : 1)
