/**
 * AgentRouter 自动签到 —— Egern 移植版
 *
 * 原脚本：ddgksf2013/Scripts agentrouter_checkin.js（Quantumult X / Loon / Surge / Node.js）
 * Egern 的 JS 运行时与 QX/Surge 完全不兼容（没有 $task / $httpClient / $prefs / $notify），
 * 因此按 Egern 官方 API（export default async function(ctx)）重写逻辑。
 *
 * 原理：POST /api/user/login 使用账号密码登录；登录本身会触发每日签到。
 * 登录后请求 /api/log/self/ 确认当天存在签到日志，并推送结果通知。
 *
 * 配置（二选一）：
 *   1) 模块环境变量（推荐，在 Egern 模块设置页图形化填写）：
 *      AGENTROUTER_ACCOUNT  = 邮箱#密码            例：name@example.com#your_password
 *      AGENTROUTER_ACCOUNTS = JSON 数组（多账号，优先级更高）
 *      AGENTROUTER_BASE_URL = https://agentrouter.org（可选）
 *      AGENTROUTER_POLICY   = 代理策略名（可选，让签到请求走代理时用）
 *      AGENTROUTER_TIMEOUT  = 单次请求超时秒数（可选，默认 20）
 *   2) 直接改下方 CONFIG（account / accounts）。
 *
 * 无需 MITM。账号密码仅发送给 baseUrl 指定的站点。
 */

const CONFIG = {
  account: "", // 例："name@example.com#your_password"
  accounts: [
    // { name: "账号1", account: "a@example.com#password" },
  ],
  baseUrl: "https://agentrouter.org",
  policy: "",
  timeoutSeconds: 20,
  verifyLog: true,
};

const LOGIN_PATH = "/api/user/login";
const USER_INFO_PATH = "/api/user/self";
const SELF_LOG_PATH = "/api/log/self/";
const SELF_LOG_HEADER = "New-API-User";
const CHECKIN_LOG_TYPE = 4;
const QUOTA_PER_DOLLAR = 5e5;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

/* ---------------- 基础工具 ---------------- */
function pad2(n) {
  return String(n).padStart(2, "0");
}
function formatTime(d) {
  const t = d || new Date();
  return (
    t.getFullYear() + "-" + pad2(t.getMonth() + 1) + "-" + pad2(t.getDate()) +
    " " + pad2(t.getHours()) + ":" + pad2(t.getMinutes()) + ":" + pad2(t.getSeconds())
  );
}
function log(msg) {
  try {
    if (typeof console !== "undefined" && console.log) console.log("[" + formatTime() + "] " + msg);
  } catch (e) {}
}
function errorMessage(e) {
  return e && typeof e === "object" ? String(e.message || e.error || JSON.stringify(e)) : String(e || "未知错误");
}
function trimString(s) {
  return typeof s === "string" ? s.trim() : "";
}
function parseBoolean(v, dflt) {
  if (typeof v === "boolean") return v;
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].indexOf(s) >= 0) return true;
  if (["0", "false", "no", "off"].indexOf(s) >= 0) return false;
  return dflt;
}
function notify(ctx, title, body) {
  try {
    ctx.notify({ title: title, body: body });
  } catch (e) {
    log("通知发送失败（不影响签到）: " + errorMessage(e));
  }
}

/* ---------------- 账号解析 ---------------- */
function parseAccount(s) {
  const t = trimString(s);
  const i = t.indexOf("#");
  if (i < 0) return { email: t, password: "" };
  return { email: t.slice(0, i).trim(), password: t.slice(i + 1).trim() };
}
function normalizeAccount(item, idx) {
  if (!item || typeof item !== "object") return null;
  let email = "", password = "";
  if (trimString(item.account)) {
    const p = parseAccount(item.account);
    email = p.email; password = p.password;
  }
  if ((!email || !password) && trimString(item.email) && trimString(item.password)) {
    email = trimString(item.email); password = trimString(item.password);
  }
  if (email && password) return { name: trimString(item.name) || "账号" + (idx + 1), email, password };
  return null;
}
function parseAccountArray(v, label) {
  let arr = v;
  if (typeof v === "string") {
    try { arr = JSON.parse(v); }
    catch (e) { log(label + " 解析失败: " + errorMessage(e)); return []; }
  }
  if (Array.isArray(arr)) return arr.map(normalizeAccount).filter(Boolean);
  if (v) log(label + " 必须是 JSON 数组");
  return [];
}

/* ---------------- 配置读取 ---------------- */
function storeGet(ctx, key) {
  try {
    const v = ctx.storage.get(key);
    return v == null ? "" : String(v);
  } catch (e) { return ""; }
}
function collectAccounts(ctx) {
  const env = (ctx && ctx.env) || {};
  let raw = trimString(env.AGENTROUTER_ACCOUNTS) || trimString(storeGet(ctx, "AGENTROUTER_ACCOUNTS"));
  if (raw) {
    const list = parseAccountArray(raw, "AGENTROUTER_ACCOUNTS");
    if (list.length) { log("已读取多账号配置，共 " + list.length + " 个"); return list; }
    log("多账号配置无有效账号，继续尝试单账号配置");
  }
  raw = trimString(env.AGENTROUTER_ACCOUNT) || trimString(storeGet(ctx, "AGENTROUTER_ACCOUNT"));
  const one = parseAccount(raw);
  if (one.email && one.password) {
    log("已读取单账号配置");
    return [{ name: "默认账号", email: one.email, password: one.password }];
  }
  const fromCfg = parseAccountArray(CONFIG.accounts, "CONFIG.accounts");
  if (fromCfg.length) { log("已读取脚本内多账号配置，共 " + fromCfg.length + " 个"); return fromCfg; }
  const single = parseAccount(CONFIG.account);
  if (single.email && single.password) {
    log("已读取脚本内单账号配置");
    return [{ name: "默认账号", email: single.email, password: single.password }];
  }
  log("未检测到有效配置：请填写 CONFIG.account / CONFIG.accounts，或设置 AGENTROUTER_ACCOUNT / AGENTROUTER_ACCOUNTS");
  return [];
}
function getRuntimeConfig(ctx) {
  const env = (ctx && ctx.env) || {};
  const baseUrl =
    trimString(env.AGENTROUTER_BASE_URL || storeGet(ctx, "AGENTROUTER_BASE_URL")) ||
    trimString(CONFIG.baseUrl) || "https://agentrouter.org";
  const timeoutRaw = trimString(env.AGENTROUTER_TIMEOUT || storeGet(ctx, "AGENTROUTER_TIMEOUT"));
  let timeoutSeconds = Number(timeoutRaw || CONFIG.timeoutSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) timeoutSeconds = 20;
  const policy =
    trimString(env.AGENTROUTER_POLICY || storeGet(ctx, "AGENTROUTER_POLICY")) || trimString(CONFIG.policy);
  const verifyLog = parseBoolean(
    trimString(env.AGENTROUTER_VERIFY_LOG || storeGet(ctx, "AGENTROUTER_VERIFY_LOG")),
    CONFIG.verifyLog !== false
  );
  return { baseUrl: baseUrl.replace(/\/+$/, ""), timeoutSeconds, policy, verifyLog };
}

/* ---------------- HTTP（Egern ctx.http，手动处理重定向与 Cookie） ---------------- */
function splitSetCookies(values) {
  const out = [];
  (values || []).forEach((v) => {
    String(v).split(/\r?\n/).forEach((line) => {
      String(line).split(/,(?=\s*[^;,\s]+=)/).forEach((part) => {
        const kv = part.split(";", 1)[0].trim();
        if (/^[^=;\s]+=.+/.test(kv) && out.indexOf(kv) < 0) out.push(kv);
      });
    });
  });
  return out;
}

async function rawRequest(ctx, req, t) {
  let url = req.url;
  let method = String(req.method || "GET").toUpperCase();
  const headers = Object.assign({}, req.headers || {});
  let body = req.body;
  const cookiePairs = [];
  for (let i = 0; i < 6; i++) {
    const fn = ctx.http[method.toLowerCase()];
    if (typeof fn !== "function") throw new Error("当前工具不支持 HTTP 方法: " + method);
    let resp;
    try {
      resp = await fn.call(ctx.http, url, {
        headers,
        body,
        timeout: t.timeoutSeconds * 1000,
        redirect: "manual",
        credentials: "omit",
        policy: t.policy || undefined,
      });
    } catch (e) {
      throw new Error(errorMessage(e));
    }
    const status = Number(resp.status || 0);
    let sc = [];
    try { sc = resp.headers.getAll("set-cookie") || []; } catch (e) {}
    splitSetCookies(sc).forEach((kv) => { if (cookiePairs.indexOf(kv) < 0) cookiePairs.push(kv); });
    const location = resp.headers.get("location");
    const isRedirect = [301, 302, 303, 307, 308].indexOf(status) >= 0 && location;
    const text = await resp.text().catch(() => "");
    if (!isRedirect) {
      return {
        status,
        contentType: resp.headers.get("content-type") || "",
        setCookies: cookiePairs.slice(),
        body: text,
      };
    }
    if (i >= 5) throw new Error("重定向次数过多");
    const next = new URL(location, url);
    if (next.origin !== new URL(url).origin) {
      throw new Error("为保护账号密码，已拒绝跨站重定向至 " + next.origin);
    }
    url = next.href;
    if (cookiePairs.length) headers["Cookie"] = cookiePairs.join("; ");
    if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      Object.keys(headers).forEach((k) => { if (/^content-(type|length)$/i.test(k)) delete headers[k]; });
    }
  }
  throw new Error("重定向次数过多");
}

function parseJsonResponse(resp, label) {
  if (String(resp.contentType || "").toLowerCase().indexOf("text/html") >= 0) {
    throw new Error(label + "返回 HTML（HTTP " + resp.status + "），可能被 WAF 拦截或接口已变化");
  }
  try {
    return JSON.parse(resp.body);
  } catch (e) {
    throw new Error(label + "返回非 JSON（HTTP " + resp.status + "）");
  }
}

/* ---------------- 业务逻辑 ---------------- */
function finiteNumber(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function quotaToDollars(q) {
  const n = finiteNumber(q);
  return n === null ? null : Math.round((n / QUOTA_PER_DOLLAR) * 100) / 100;
}
function quotaDetailsFromUserData(d, source) {
  if (!d || typeof d !== "object") return { remaining: null, used: null, total: null, source: source || "unknown" };
  const remaining = quotaToDollars(d.quota);
  const used = quotaToDollars(d.used_quota);
  const totalQ = quotaToDollars(d.total_quota);
  return {
    remaining,
    used,
    total: totalQ !== null ? totalQ : (remaining !== null && used !== null ? Math.round((remaining + used) * 100) / 100 : null),
    source: source || "unknown",
  };
}
function moneyText(v) {
  const n = finiteNumber(v);
  return n === null ? "未知" : "$" + n.toFixed(2);
}
function safeServerMessage(msg, account) {
  let s = String(msg || "未知错误").replace(/[\r\n]+/g, " ").slice(0, 160);
  [account.email, account.password].forEach((secret) => {
    if (secret) s = s.split(secret).join("***");
  });
  return s;
}
function makeResult(name, status, message, username, quota) {
  const q = quota || { remaining: null, used: null, total: null, source: "unknown" };
  const r = {
    name, status, message, username: username || "",
    quota: q.remaining, usedQuota: q.used, totalQuota: q.total, quotaSource: q.source,
    time: formatTime(),
  };
  log("[" + name + "] " + ({ success: "✅ 成功", already: "🟡 已签到", fail: "❌ 失败" }[status] || status) +
    " | " + message + " | 剩余: " + moneyText(r.quota) + " | 已用: " + moneyText(r.usedQuota) + " | 总额度: " + moneyText(r.totalQuota));
  return r;
}
function agoText(sec) {
  const t = Math.max(0, Math.floor(sec));
  if (t < 60) return t + " 秒前";
  if (t < 3600) return Math.floor(t / 60) + " 分钟前";
  if (t < 86400) return Math.floor(t / 3600) + " 小时前";
  return Math.floor(t / 86400) + " 天前";
}

async function verifyCheckin(ctx, t, uid, cookie, windowSec, days) {
  if (!uid) return { level: "error", detail: "缺少 uid，跳过日志核验" };
  const headers = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": USER_AGENT,
    [SELF_LOG_HEADER]: String(uid),
  };
  if (cookie) headers["Cookie"] = cookie;
  let resp;
  try {
    resp = await rawRequest(ctx, { url: t.baseUrl + SELF_LOG_PATH + "?p=1&page_size=20", method: "GET", headers }, t);
  } catch (e) {
    return { level: "error", detail: "日志查询异常: " + errorMessage(e) };
  }
  if (resp.status !== 200 || String(resp.contentType || "").toLowerCase().indexOf("text/html") >= 0) {
    return { level: "error", detail: "日志接口返回 HTTP " + resp.status };
  }
  let data;
  try { data = JSON.parse(resp.body); }
  catch (e) { return { level: "error", detail: "日志接口返回非 JSON" }; }
  const items = data && data.data && Array.isArray(data.data.items) ? data.data.items : [];
  let latest = null, content = "";
  items.forEach((it) => {
    if (!it || typeof it !== "object") return;
    const c = String(it.content || "");
    const hit = c.indexOf("签到成功") >= 0 || Number(it.type) === CHECKIN_LOG_TYPE;
    const ts = Number(it.created_at);
    if (hit && Number.isFinite(ts) && (latest === null || ts > latest)) { latest = ts; content = c; }
  });
  if (latest === null) return { level: "none", detail: "日志中未找到任何签到记录" };
  const now = Math.floor(Date.now() / 1000);
  const ago = agoText(now - latest);
  if (latest >= now - windowSec) return { level: "new", detail: "本次运行已生成签到日志（" + ago + "）", timestamp: latest, content };
  if (latest >= now - 86400 * days) return { level: "today", detail: "近 " + days + " 天内有签到记录（" + ago + "），本次未新增", timestamp: latest, content };
  return { level: "none", detail: "最近一条签到日志较旧（" + ago + "）", timestamp: latest, content };
}

async function fetchQuotaDetails(ctx, t, uid, cookie, loginData) {
  const fallback = quotaDetailsFromUserData(loginData, "login-fallback");
  if (!uid) return { details: fallback, warning: "缺少 uid，无法查询完整账户额度" };
  const headers = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": USER_AGENT,
    [SELF_LOG_HEADER]: String(uid),
  };
  if (cookie) headers["Cookie"] = cookie;
  let resp;
  try {
    resp = await rawRequest(ctx, { url: t.baseUrl + USER_INFO_PATH, method: "GET", headers }, t);
  } catch (e) {
    return { details: fallback, warning: "账户额度查询异常: " + errorMessage(e) };
  }
  if (resp.status !== 200) return { details: fallback, warning: "账户额度接口返回 HTTP " + resp.status };
  let data;
  try { data = parseJsonResponse(resp, "账户额度接口"); }
  catch (e) { return { details: fallback, warning: errorMessage(e) }; }
  if (!data || !data.success || !data.data || typeof data.data !== "object") {
    return { details: fallback, warning: "账户额度接口未返回有效用户数据" };
  }
  const details = quotaDetailsFromUserData(data.data, "user-self");
  if (details.remaining === null && details.used === null && details.total === null) {
    return { details: fallback, warning: "账户资料中未找到 quota / used_quota / total_quota" };
  }
  return { details, warning: "" };
}

async function passwordLogin(ctx, account, t) {
  const name = account.name || "默认账号";
  if (!account.email || !account.password) {
    return makeResult(name, "fail", "未配置 email/password，跳过", "", null);
  }
  log("====== 开始处理账号（账号密码登录）: " + name + " ======");
  let resp;
  try {
    resp = await rawRequest(ctx, {
      url: t.baseUrl + LOGIN_PATH,
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        Referer: t.baseUrl + "/login",
        Origin: t.baseUrl,
      },
      body: JSON.stringify({ username: account.email, password: account.password }),
    }, t);
  } catch (e) {
    return makeResult(name, "fail", "登录请求异常: " + safeServerMessage(errorMessage(e), account), "", null);
  }
  let data;
  try { data = parseJsonResponse(resp, "登录接口"); }
  catch (e) { return makeResult(name, "fail", errorMessage(e), "", null); }
  if (!data || !data.success) {
    return makeResult(name, "fail", "登录失败: " + safeServerMessage(data && data.message, account), "", null);
  }
  const d = data.data && typeof data.data === "object" ? data.data : {};
  const checkedIn = Boolean(d.checked_in);
  const username = d.username || d.display_name || account.email;
  const cookie = splitSetCookies(resp.setCookies).join("; ");
  const q = await fetchQuotaDetails(ctx, t, d.id, cookie, d);
  const details = q.details;
  let msg;
  if (checkedIn && t.verifyLog) {
    const v = await verifyCheckin(ctx, t, d.id, cookie, 300, 1);
    if (v.level === "new" || v.level === "today") {
      msg = "签到成功，日志已确认（" + v.detail + "）";
    } else {
      msg = "登录成功且服务端返回已签到，但日志未确认: " + v.detail;
      if (!cookie) msg += "；登录响应中未读取到 Set-Cookie";
    }
  } else {
    msg = checkedIn ? "签到成功（已关闭日志核验）" : "登录成功，但 checked_in=false（可能今日额度已发或接口变化）";
  }
  if (q.warning) {
    msg += "；" + q.warning;
    if (details.source === "login-fallback") msg += "，当前额度来自登录响应后备值";
  }
  return makeResult(name, "success", msg, username, details);
}

function buildSummary(results) {
  const lines = results.map((r) => {
    const icon = r.status === "fail" ? "❌" : r.status === "already" ? "🟡" : "✅";
    return icon + " " + r.name + "\n" + r.message +
      "\n剩余额度: " + moneyText(r.quota) + "｜已用: " + moneyText(r.usedQuota) + "｜总额度: " + moneyText(r.totalQuota);
  }).join("\n\n");
  const withTotal = results.filter((r) => finiteNumber(r.totalQuota) !== null);
  if (!withTotal.length) return lines;
  const sum = withTotal.reduce((acc, r) => {
    const n = finiteNumber(r.quota), u = finiteNumber(r.usedQuota), o = finiteNumber(r.totalQuota);
    if (n !== null) acc.remaining += n; else acc.remainingKnown = false;
    if (u !== null) acc.used += u; else acc.usedKnown = false;
    if (o !== null) acc.total += o;
    return acc;
  }, { remaining: 0, used: 0, total: 0, remainingKnown: true, usedKnown: true });
  return lines + "\n\n📊 " + withTotal.length + " 个账号合计" +
    "\n剩余额度: " + (sum.remainingKnown ? moneyText(sum.remaining) : "部分未知") +
    "｜已用: " + (sum.usedKnown ? moneyText(sum.used) : "部分未知") +
    "｜总额度: " + moneyText(sum.total);
}

/* ---------------- 入口（Egern Schedule 脚本） ---------------- */
export default async function (ctx) {
  try {
    log("AgentRouter 自动签到启动（账号密码登录即签到）");
    const t = getRuntimeConfig(ctx);
    const accounts = collectAccounts(ctx);
    if (!accounts.length) {
      notify(ctx, "AgentRouter 签到失败", "未检测到有效账号配置：请在模块设置中填写 AGENTROUTER_ACCOUNT（邮箱#密码），或在脚本 CONFIG 中填写 account");
      return;
    }
    const results = [];
    for (const a of accounts) {
      results.push(await passwordLogin(ctx, a, t));
    }
    notify(ctx, "AgentRouter 签到", buildSummary(results));
  } catch (e) {
    log("脚本异常: " + errorMessage(e));
    notify(ctx, "AgentRouter 签到异常", errorMessage(e));
  }
}
