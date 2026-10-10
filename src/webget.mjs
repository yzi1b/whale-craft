/**
 * whale_craft / webget.mjs —— 插件**自己的**公网 HTTP 抓取（`mc_kit_web_fetch` 的唯一出网口）
 * ============================================================================
 * 为什么不用宿主的 `ctx.web`（2026-10-08 用户定："全改成自己的可控逻辑，宿主的强关联就不要了"）
 *   · 宿主 `dsh-web-fetch-http` **拿不到二进制**（`readBody` 先按 content-type 分类，`image/*` 一律
 *     `WEB_UNSUPPORTED_CONTENT_TYPE`），图片本来就得自己下 —— 与其"文本走宿主、图片走自己"两套逻辑，
 *     不如全由本模块统一：一次请求、按真实 Content-Type 判型、一套上限与一套错误文案；
 *   · 也不再有"宿主 `web` 服务缺失就抓不了"、"宿主代理配置被绕开"这类耦合。
 * 代价（明确记账）：charset 解码、content-encoding、类型分类、大小上限**都由我们负责**（见下），
 *   且**不支持代理**（宿主 provider 有 `proxyRouteFor`）。
 *
 * 🔴 安全：本模块是**唯一**出网口，防 SSRF 全在这里（逐条对齐宿主 `dsh-web-fetch-http/src/network.ts`，
 *   但**不依赖** `ipaddr.js` —— 那是宿主包）：
 *      ① 只允许 http/https、**禁止 URL 里的用户名/密码**、长度 ≤2048；
 *      ② **先自己解析 DNS**，**每一个**地址都必须是公网（私网/回环/链路本地/保留/多播/文档段全拒）；
 *      ③ 校验通过后把地址**钉死**（`lookup` 回调只回这份名单）——传输层不再解析，防 DNS rebinding；
 *      ④ 只跟随**同源**跳转（scheme+host+port 全同），最多 5 次；
 *      ⑤ 限大小与超时，并接 `AbortSignal`；不带 cookie、不带凭据。
 *
 * 内容类型（用户 2026-10-08：「只有内置的格式和未知的格式」）：
 *   · `html`  = `text/html` / `application/xhtml+xml`；
 *   · `text`  = 其余 `text/*` + `application/json` / `application/xml` / `*+json` / `*+xml`（含 `image/svg+xml`）；
 *   · `image` = **只有内置那四种**（`WEB_IMAGE_FORMATS`：png / jpeg / gif / webp，= 宿主附件服务认的）；
 *   · 其余一律 **不支持**（不区分"是图片但没内置"与"根本不是图片"）——在**读 body 之前**就拒。
 *
 * 测试缝（照宿主同款）：`lookup` 与 `assertPublic` 可注入 —— selfcheck 用它对着**本机 http 服务**跑通链路
 * （本机 = 私网地址，正常路径会拒；注入后才走得到）。
 * ============================================================================
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib'

/** 文本类响应的**解码后**字节上限（与宿主 provider 的 `maxResponseBytes` 一致）。 */
export const WEB_GET_MAX_BYTES = 5 * 1024 * 1024
/** 正文解码后的字符上限（与宿主 provider 的 `maxBodyChars` 一致）——超了**截断**（不算错）。 */
export const WEB_GET_MAX_BODY_CHARS = 100_000
/** 单张图片的字节上限（= 宿主 `dsh-attachment-local` 的 `maxImageBytes` 默认 20MB）。 */
export const WEB_IMAGE_MAX_BYTES = 20 * 1024 * 1024
/** 整次抓取（含 DNS 解析与跳转）的时间上限。 */
export const WEB_GET_TIMEOUT_MS = 30_000
/** 最多跟随几次跳转（与宿主 provider 一致）。 */
export const WEB_GET_MAX_REDIRECTS = 5
/** URL 文本长度上限（与宿主 provider 一致）。 */
export const WEB_GET_MAX_URL_LENGTH = 2048

/** 请求头里的 accept（与宿主 provider 基本一致，另加 `image/*` —— 我们也直接抓图）。 */
const ACCEPT = 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8,image/*;q=0.8'

/**
 * 内置支持的图片格式（**不可配置**）。就是宿主附件服务（`dsh-attachment-local` 的 `imageLimits.mediaTypes`）
 * 认的那四种 —— 别的格式就算能下下来也**没法给模型看**，所以一律算不支持。
 */
export const WEB_IMAGE_FORMATS = Object.freeze(['png', 'jpeg', 'gif', 'webp'])

/** `image/<subtype>` 的规范名（只有 `jpg → jpeg` 这一个别名要归一） */
const canonicalSubtype = (sub) => (sub === 'jpg' ? 'jpeg' : sub)

/** `Content-Type` → 去掉参数的纯 mime（小写） */
const mimeOf = (contentType) => String(contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()

/** `Content-Type` → 声明的 charset（小写；没有 → `undefined`） */
export function charsetOf (contentType) {
  return /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(String(contentType ?? ''))?.[1]?.trim().toLowerCase()
}

/**
 * Content-Type → **支持的**图片格式名；不是图片 / 不在内置名单里 → `null`。
 * @param {string|null|undefined} mediaType
 * @returns {string|null}
 */
export function supportedImageFormat (mediaType) {
  const mime = mimeOf(mediaType)
  if (!mime.startsWith('image/')) return null
  const sub = mime.slice('image/'.length).trim()
  if (!sub) return null
  const name = canonicalSubtype(sub)
  return WEB_IMAGE_FORMATS.includes(name) ? name : null
}

/**
 * Content-Type → 我们支持的内容大类。落不进任何一类 → `null`（调用方按"不支持"处理）。
 * @param {string|null|undefined} contentType
 * @returns {{kind:'html'|'text'|'image', format?:string, mediaType:string}|null}
 */
export function classifyContentType (contentType) {
  const mime = mimeOf(contentType)
  if (!mime) return null
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return { kind: 'html', mediaType: mime }
  const image = supportedImageFormat(mime)
  if (image) return { kind: 'image', format: image, mediaType: mime }
  if (mime.startsWith('text/')) return { kind: 'text', mediaType: mime }
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) {
    return { kind: 'text', mediaType: mime }
  }
  return null
}

/**
 * 这个大类现在允许抓吗（三个开关都是**精确**判定 —— 现在有真实 Content-Type 了，不再像"走宿主"时那样只能粗判）。
 * @param {'html'|'text'|'image'|string} kind
 * @param {{html?:boolean, text?:boolean, image?:boolean}} allow
 */
export function contentTypeAllowed (kind, allow = {}) {
  if (kind === 'html') return allow.html === true
  if (kind === 'text') return allow.text === true
  if (kind === 'image') return allow.image === true
  return false
}

/**
 * 按声明的 charset 解码正文（默认 utf-8），并压到 {@link WEB_GET_MAX_BODY_CHARS}。
 * 不认识的 charset **直接报错**（宁可说清，也不要吐一堆乱码）。
 * @param {Buffer} bytes
 * @param {string|undefined} charset
 * @param {number} [maxChars]
 * @returns {{text:string, truncated:boolean}}
 */
export function decodeBodyText (bytes, charset, maxChars = WEB_GET_MAX_BODY_CHARS) {
  let decoder
  try {
    decoder = charset ? new TextDecoder(charset) : new TextDecoder('utf-8')
  } catch {
    throw new Error(`这个页面声明的字符编码不认识（charset=${charset}），抓了也是乱码——抓不了。`)
  }
  const text = decoder.decode(bytes)
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars }
}

/** 解析 IPv4 文本 → 四个字节；不合法 → null */
function parseV4 (s) {
  const parts = String(s).split('.')
  if (parts.length !== 4) return null
  const out = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/** IPv4 是不是公网单播（私有/回环/链路本地/保留/多播/文档段一律 false） */
function isPublicV4 (s) {
  const b = parseV4(s)
  if (!b) return false
  const [o1, o2, o3] = b
  if (o1 === 0 || o1 === 10 || o1 === 127) return false              // 0/8、10/8、回环
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return false              // 100.64/10 CGNAT
  if (o1 === 169 && o2 === 254) return false                         // 169.254/16 链路本地
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return false               // 172.16/12
  if (o1 === 192 && o2 === 168) return false                         // 192.168/16
  if (o1 === 192 && o2 === 0 && (o3 === 0 || o3 === 2)) return false // 192.0.0/24、192.0.2/24
  if (o1 === 192 && o2 === 88 && o3 === 99) return false             // 192.88.99/24 6to4 中继
  if (o1 === 198 && (o2 === 18 || o2 === 19)) return false           // 198.18/15 基准测试
  if (o1 === 198 && o2 === 51 && o3 === 100) return false            // 198.51.100/24 文档
  if (o1 === 203 && o2 === 0 && o3 === 113) return false             // 203.0.113/24 文档
  if (o1 >= 224) return false                                        // 多播 + 保留 + 广播
  return true
}

/** IPv6 文本 → 8 个 16 位组（含 `::` 展开、末尾 IPv4 混合写法）；不合法 → null */
function parseV6 (input) {
  let s = String(input).trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  if (s.includes('%')) s = s.slice(0, s.indexOf('%'))            // 去 zone id
  if (!s.includes(':')) return null
  let tail = null
  const lastColon = s.lastIndexOf(':')
  const after = s.slice(lastColon + 1)
  if (after.includes('.')) {                                     // ::ffff:1.2.3.4 这类混合写法
    const v4 = parseV4(after)
    if (!v4) return null
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
    s = s.slice(0, lastColon + 1) + '0:0'
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const toGroups = (part) => (part ? part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : null)) : [])
  const head = toGroups(halves[0])
  const tailGroups = halves.length === 2 ? toGroups(halves[1]) : null
  if (head.includes(null) || (tailGroups && tailGroups.includes(null))) return null
  let groups
  if (tailGroups === null) {
    groups = head
  } else {
    const fill = 8 - head.length - tailGroups.length
    if (fill < 0) return null
    groups = [...head, ...Array(fill).fill(0), ...tailGroups]
  }
  if (groups.length !== 8) return null
  if (tail) { groups[6] = tail[0]; groups[7] = tail[1] }
  return groups
}

/**
 * IPv6 是不是公网单播。**比宿主更严**（宿主用 ipaddr.js 的 `range()`；这里把 tunnelling / 转换前缀
 * 一并按内嵌 IPv4 复核，复核不了就拒）：
 *   · 只放行 `2000::/3`（全局单播）；
 *   · 内嵌 IPv4 的三种（IPv4-mapped `::ffff:a.b.c.d`、NAT64 `64:ff9b::/96`、6to4 `2002::/16`）→ 复核内嵌地址；
 *   · Teredo（`2001:0::/32`）、文档段（`2001:db8::/32`、`3fff::/20`）、本地用 NAT64（`64:ff9b:1::/48`）一律拒。
 */
export function isPublicIp (input) {
  const s = String(input ?? '').trim()
  const fam = isIP(s)
  if (fam === 4) return isPublicV4(s)
  if (fam !== 6) return false
  const g = parseV6(s)
  if (!g) return false
  const embedded = (a, b, c, d) => isPublicV4(`${a}.${b}.${c}.${d}`)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0) {
    if (g[5] === 0xffff) return embedded(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff)   // ::ffff:a.b.c.d
    if (g[5] === 0) return false                                                          // :: / ::1 / ...
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return embedded(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff)                        // 64:ff9b::/96
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false                          // 64:ff9b:1::/48
  if (g[0] === 0x2002) return embedded(g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff)      // 2002::/16 6to4
  if (g[0] === 0x2001 && g[1] === 0) return false                                           // 2001:0::/32 Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false                                      // 2001:db8::/32 文档
  if (g[0] === 0x3fff && g[1] < 0x1000) return false                                        // 3fff::/20 文档
  return (g[0] & 0xe000) === 0x2000                                                         // 2000::/3
}

/** 只认 http/https；顺便把"带凭据 / 太长"挡掉 */
function parseTarget (raw) {
  const s = String(raw ?? '').trim()
  if (!s) throw new Error('url 不能为空')
  if (s.length > WEB_GET_MAX_URL_LENGTH) throw new Error(`网址太长（上限 ${WEB_GET_MAX_URL_LENGTH} 字符）`)
  let u
  try { u = new URL(s) } catch { throw new Error(`不是合法的网址：${s}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`只支持 http/https：${s}`)
  if (u.username || u.password) throw new Error('网址里不允许带用户名/密码')
  return u
}

/** 同源（scheme + host + port 全同）——只有同源跳转才跟随 */
const sameOrigin = (a, b) => a.protocol === b.protocol && a.hostname === b.hostname && (a.port || '') === (b.port || '')

/** 把「地址集合 → 只回这份集合」的钉死 lookup 交给 http(s).request */
function pinnedLookup (addresses) {
  return (hostname, options, callback) => {
    const all = Array.isArray(addresses) ? addresses : []
    if (!all.length) { callback(new Error(`没有可用地址：${hostname}`)); return }
    if (options && options.all) callback(null, all.map((a) => ({ address: a.address, family: a.family })))
    else callback(null, all[0].address, all[0].family)
  }
}

/**
 * 抓一个公网 URL（**唯一**的出网口）。按真实 Content-Type 判型；判不出来（或不支持）在**读 body 之前**就拒。
 *
 * @param {string} rawUrl
 * @param {{signal?:AbortSignal, lookup?:Function, assertPublic?:Function, maxBytes?:number,
 *          maxRedirects?:number, timeoutMs?:number}} [opts]
 *   `lookup` / `assertPublic` 是**测试缝**（默认 `dns.promises.lookup` 与 {@link isPublicIp}）。
 * @returns {Promise<{url:string, statusCode:number, contentType:string, charset:string|undefined,
 *   kind:'html'|'text'|'image', format:string|undefined, mediaType:string, body:Buffer, truncatedByBytes:boolean}>}
 */
export async function fetchUrl (rawUrl, opts = {}) {
  const {
    signal,
    lookup = dnsLookup,
    assertPublic = isPublicIp,
    maxBytes,
    maxRedirects = WEB_GET_MAX_REDIRECTS,
    timeoutMs = WEB_GET_TIMEOUT_MS,
  } = opts
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const onOuterAbort = () => deadline.abort()
  if (signal) {
    if (signal.aborted) deadline.abort()
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const finish = () => {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onOuterAbort)
  }
  /** 请求失败时把"超时 / 被中断"与普通网络错误分开说 */
  const describe = (e) => {
    if (!deadline.signal.aborted) return e
    return new Error(signal?.aborted
      ? '抓取被中断（用户停止 / 会话取消）。'
      : `抓取超时（${Math.round(timeoutMs / 1000)} 秒）。可以稍后重试，或换一个更轻的地址。`)
  }
  try {
    let target = parseTarget(rawUrl)
    let redirects = 0
    for (;;) {
      const host = target.hostname.replace(/^\[|\]$/g, '')
      // ① 解析 + 校验（每个地址都必须是公网）
      let resolved
      try {
        resolved = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, order: 'verbatim' })
      } catch (e) {
        throw new Error(`域名解析失败（${host}）：${e?.code ?? e?.message ?? e}`)
      }
      if (!Array.isArray(resolved) || !resolved.length) throw new Error(`域名解析不到地址：${host}`)
      for (const entry of resolved) {
        if (!assertPublic(entry.address)) {
          throw new Error(`这个域名解析到了非公网地址（${entry.address}），拒绝抓取 —— 只允许公网地址。`)
        }
      }
      // ② 发请求（地址钉死）。上限先按"文本"这一档做 Content-Length 预检（图片更大，见下按类型再调）
      const cap = Number.isFinite(maxBytes) ? maxBytes : WEB_IMAGE_MAX_BYTES
      let res
      try {
        res = await requestOnce(target, resolved, deadline.signal, cap)
      } catch (e) {
        throw describe(e)
      }
      const status = res.statusCode
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirects >= maxRedirects) throw new Error(`跳转次数超过上限（${maxRedirects} 次）`)
        const next = new URL(res.headers.location, target)
        if (!sameOrigin(next, target)) {
          throw new Error(`跨域跳转到 ${next.origin} 不自动跟随 —— 请直接抓最终那个地址。`)
        }
        redirects += 1
        target = next
        continue
      }
      if (status < 200 || status >= 300) {
        res.resume()
        throw new Error(`抓取失败：HTTP ${status}`)
      }
      const contentType = String(res.headers['content-type'] ?? '').trim()
      const type = classifyContentType(contentType)
      if (!type) {
        res.resume()
        throw new Error(`这个地址返回的是 ${mimeOf(contentType) || '未知类型'}，不受支持`
          + `（只能抓 HTML / 纯文本 / JSON / XML，图片只支持 ${WEB_IMAGE_FORMATS.join(' / ')}）。`)
      }
      // 上限按类型定：图片 20MB；文本 5MB（**超了就截断**，与宿主 provider 一致——那是"页面太长"，不是错）
      const isImage = type.kind === 'image'
      const limit = isImage ? WEB_IMAGE_MAX_BYTES : (Number.isFinite(maxBytes) ? maxBytes : WEB_GET_MAX_BYTES)
      let body
      try {
        body = await readBody(res, { maxBytes: limit, cut: !isImage, signal: deadline.signal })
      } catch (e) {
        throw describe(e)
      }
      return {
        url: target.toString(),
        statusCode: status,
        contentType,
        charset: charsetOf(contentType),
        kind: type.kind,
        format: type.format,
        mediaType: mimeOf(contentType),
        body: body.bytes,
        truncatedByBytes: body.truncated,
      }
    }
  } finally {
    finish()
  }
}

/**
 * 一次 GET（不跟随跳转）。带 Content-Length 预检。
 *
 * ⚠️ 只能有**一处**"响应到达"的处理点（回调里判完 `Content-Length` 再 resolve）。
 *    曾经把 `resolve` 直接当请求回调、另挂 `req.on('response')` 判长度 —— 两处都会跑，结果是
 *    "超限时 destroy 掉的正是已经 resolve 出去的那个响应"，随后读 body 的 await **永不 settle**（真机卡死）。
 */
function requestOnce (url, addresses, signal, maxBytes) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = mod({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        // 不带 cookie、不带凭据；不声明 accept-encoding（默认 identity，避免被压缩）
        accept: ACCEPT,
        'user-agent': 'whale_craft/mc_kit_web_fetch',
      },
      lookup: pinnedLookup(addresses),   // 🔴 地址钉死：传输层不再解析
      signal,
    }, (res) => {
      const len = Number(res.headers['content-length'])
      if (Number.isFinite(len) && len > maxBytes) {
        res.resume()                     // 排空再抛，别把 socket 挂在那儿
        reject(new Error(`响应太大（${len} 字节，上限 ${maxBytes}）`))
        return
      }
      resolve(res)
    })
    req.on('error', (e) => reject(new Error(`抓取失败：${e?.message ?? e}`)))
    req.end()
  })
}

/**
 * 读完响应体。必要时先解压（`gzip` / `deflate` / `br`；我们**不**声明 accept-encoding，但服务器硬压也认）。
 * `cut=true`（文本）：超上限 → **截断**并标记；`cut=false`（图片）：超上限 → 报错（截一半的图是坏图）。
 * `close` 兜底：流被提前关掉时也必须 settle。
 */
function readBody (res, { maxBytes, cut, signal }) {
  const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase().trim()
  let stream = res
  if (encoding && encoding !== 'identity') {
    if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(createGunzip())
    else if (encoding === 'deflate') stream = res.pipe(createInflate())
    else if (encoding === 'br') stream = res.pipe(createBrotliDecompress())
    else {
      res.resume()
      return Promise.reject(new Error(`服务器用了不支持的压缩方式（content-encoding: ${encoding}）——抓不了。`))
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    let truncated = false
    const done = (fn, v) => { if (!settled) { settled = true; fn(v) } }
    const fail = (e) => { done(reject, e); stream.destroy() }
    stream.on('data', (chunk) => {
      if (truncated) return
      total += chunk.length
      if (total > maxBytes) {
        if (!cut) { fail(new Error(`图片太大（超过上限 ${maxBytes} 字节）`)); return }
        truncated = true
        const keep = maxBytes - (total - chunk.length)
        if (keep > 0) chunks.push(chunk.subarray(0, keep))
        stream.destroy()
        done(resolve, { bytes: Buffer.concat(chunks), truncated: true })
        return
      }
      chunks.push(chunk)
    })
    stream.on('end', () => {
      if (signal?.aborted) { done(reject, new Error('抓取被中断')); return }
      done(resolve, { bytes: Buffer.concat(chunks), truncated })
    })
    stream.on('error', (e) => fail(new Error(`抓取中断：${e?.message ?? e}`)))
    stream.on('close', () => done(reject, new Error('抓取中断（连接提前关闭）')))
  })
}
