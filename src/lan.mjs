// -*- coding: utf-8 -*-
/**
 * whale_craft / lan.mjs —— **局域网 Minecraft 服务器探测**
 * ============================================================================
 * 用户 2026-09-16 要求："加一个工具，可以探测局域网服务器。"
 * 用户 2026-09-18 砍掉扫段："原版都没有，我们凭什么加！一个工具调用半天，用户又说慢！"
 *
 * **只做原版那一件事：听多播公告。**
 *   Minecraft（原版客户端"对局域网开放"、原版服务端 `enable-lan-visibility`、
 *   以及复刻同样行为的一堆插件）会周期性往多播组 `224.0.2.60:4445` 发一条 UDP：
 *     `[MOTD]...[/MOTD][AD]端口[/AD]`
 *   发包侧重发周期 1500ms（第三方复刻实现 `timer.schedule(..., 0, 1500)`），
 *   所以听 3 秒就够——原版客户端也是**纯被动听**，从不扫端口。
 *
 * 🔴 **为什么砍掉扫段**（曾经有：/24 × 25565-25569 的 TCP 探测 + STATUS ping）：
 *   · 一个 /24 实测 8.2s，最坏（TCP 通但不回 MC 协议）可达 100s 级、多网段分钟级；
 *   · 它得到的"版本 / MOTD / 人数"在 `mc_connect` 进服时本来就会拿到
 *     （mineflayer 传 `version:false` → minecraft-protocol `autoVersion` 内部就是 STATUS ping）；
 *   · 唯一不可替代的只有"没开公告的服务器"，而那种情况原版自己也找不到 —— 让玩家报地址。
 *   于是：**不扫端口、不连服、恒定 3~15 秒返回**，也不再像网络扫描器。
 * ============================================================================
 */
import { createSocket } from 'node:dgram'

/** Minecraft 的局域网广播地址（客户端"对局域网开放"用的多播组） */
export const LAN_BROADCAST = { group: '224.0.2.60', port: 4445 }

/* ─────────────────────────── 纯函数（好测） ─────────────────────────── */

/**
 * 解析 Minecraft 的局域网广播文本。
 * 形如：`[MOTD]A Minecraft Server[/MOTD][AD]25565[/AD]`（AD = 端口）
 * @returns {{motd: string, port: number}|null} 不是这种格式就 null
 */
export function parseLanBroadcast (msg) {
  const s = String(msg ?? '')
  const ad = /\[AD\]([\s\S]*?)\[\/AD\]/i.exec(s)
  if (!ad) return null
  const port = Number(String(ad[1]).trim())
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const motd = /\[MOTD\]([\s\S]*?)\[\/MOTD\]/i.exec(s)
  return { motd: motd ? motd[1].trim() : '', port }
}

/* ─────────────────────────── 网络探测 ─────────────────────────── */

/**
 * 实际监听时长（毫秒）：秒数夹在 [0.5, 15]；缺省/非法 → 3 秒。
 * 纯函数，自检验上限时不必真等 15 秒。
 * @param {number|string} seconds
 * @returns {number}
 */
export function lanWaitMs (seconds) {
  return Math.max(500, Math.min(Number(seconds) || 3, 15) * 1000)
}

/**
 * 听 Minecraft 的局域网广播（多播 224.0.2.60:4445）。
 * 到点自动收工；有些环境禁多播，那就只听本机广播，拿不到也不报错。
 * @returns {Promise<Array<{host:string, port:number, motd:string, source:'broadcast'}>>}
 */
export function listenLanBroadcast ({ seconds = 3, group = LAN_BROADCAST.group, port = LAN_BROADCAST.port } = {}) {
  return new Promise((resolve) => {
    const found = []
    let closed = false
    let sock = null
    const close = () => {
      if (closed) return
      closed = true
      try { sock?.close() } catch { /* 没开成 */ }
      resolve(found)
    }
    try {
      sock = createSocket({ type: 'udp4', reuseAddr: true })
      sock.on('error', () => close())
      sock.on('message', (msg, rinfo) => {
        if (closed) return
        const parsed = parseLanBroadcast(msg.toString('utf8'))
        if (!parsed) return
        const host = String(rinfo?.address ?? '')
        if (found.some((f) => f.host === host && f.port === parsed.port)) return
        found.push({ host, port: parsed.port, motd: parsed.motd, source: 'broadcast' })
      })
      sock.bind(port, () => {
        try { sock.addMembership(group) } catch { /* 禁多播的环境：只听本机广播 */ }
      })
    } catch { close() }
    const t = setTimeout(close, lanWaitMs(seconds))
    t.unref?.()
  })
}
