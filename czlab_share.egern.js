/**
 * czlab 兑换码每日分享 —— Egern 脚本
 *
 * 目标站点：https://code.czlab.dev（互相分享 Muse 兑换码的社区站）
 *
 * 原理：兑换码仅在池中公开展示 24 小时。每天运行一次：先查询自己的码是否还在
 * 池中展示，在则跳过（不重复提交）；不在则 POST 提交，保持持续曝光。
 *
 * 接口（2026-10-09 实测）：
 *   GET  /api/codes/<CODE>  → { exists, active, expired, copy_count }
 *   POST /api/codes         → body {"code":"XXXXXX"}，成功 2xx，失败如 400 + { message }
 * 兑换码格式：恰好 6 位英文或数字（与站点前后端 CODE_RE 一致）。
 *
 * 配置（优先级：模块环境变量 > 模块存储 > 脚本内 CONFIG）：
 *   CZLAB_CODE      单个兑换码，例如 WDE0F2
 *   CZLAB_CODES     多个兑换码，逗号/空格/换行分隔，例如 WDE0F2,AB12CD（可选）
 *   CZLAB_BASE_URL  站点地址（可选，默认 https://code.czlab.dev）
 *   CZLAB_POLICY    代理策略名（可选，让请求走代理时用）
 *   CZLAB_TIMEOUT   单次请求超时秒数（可选，默认 20）
 *
 * 无需登录、无需 MITM。提交的兑换码本来就是公开展示的，不含敏感信息。
 */

const CONFIG = {
  code: "",      // 例："WDE0F2"
  codes: [],     // 例：["WDE0F2", "AB12CD"]
  baseUrl: "https://code.czlab.dev",
  policy: "",
  timeoutSeconds: 20,
};

const CODE_RE = /^[A-Za-z0-9]{6}$/;
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

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
function notify(ctx, title, body) {
  try {
    ctx.notify({ title: title, body: body });
  } catch (e) {
    log("通知发送失败（不影响提交）: " + errorMessage(e));
  }
}

/* ---------------- 配置读取 ---------------- */
function storeGet(ctx, key) {
  try {
    const v = ctx.storage.get(key);
    return v == null ? "" : String(v);
  } catch (e) { return ""; }
}
function envGet(ctx, key) {
  const env = (ctx && ctx.env) || {};
  return trimString(env[key]) || trimString(storeGet(ctx, key));
}
function splitCodes(raw) {
  return trimString(raw)
    .split(/[\s,;，；、]+/)
    .map(trimString)
    .filter(Boolean);
}
function collectCodes(ctx) {
  const seen = {};
  const out = [];
  function add(list) {
    list.forEach((c) => {
      const code = trimString(c).toUpperCase();
      if (code && !seen[code]) { seen[code] = true; out.push(code); }
    });
  }
  add(splitCodes(envGet(ctx, "CZLAB_CODE")));
  add(splitCodes(envGet(ctx, "CZLAB_CODES")));
  add(splitCodes(CONFIG.code));
  if (Array.isArray(CONFIG.codes)) add(CONFIG.codes);
  if (!out.length) {
    log("未检测到兑换码配置：请在模块设置中填写 CZLAB_CODE，或在脚本 CONFIG 中填写 code");
  } else {
    log("已读取 " + out.length + " 个兑换码");
  }
  return out;
}
function getRuntimeConfig(ctx) {
  const baseUrl =
    envGet(ctx, "CZLAB_BASE_URL") || trimString(CONFIG.baseUrl) || "https://code.czlab.dev";
  const timeoutRaw = envGet(ctx, "CZLAB_TIMEOUT");
  let timeoutSeconds = Number(timeoutRaw || CONFIG.timeoutSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) timeoutSeconds = 20;
  const policy = envGet(ctx, "CZLAB_POLICY") || trimString(CONFIG.policy);
  return { baseUrl: baseUrl.replace(/\/+$/, ""), timeoutSeconds, policy };
}

/* ---------------- HTTP（Egern ctx.http） ---------------- */
async function apiRequest(ctx, method, url, jsonBody, t) {
  const m = String(method || "GET").toUpperCase();
  const fn = ctx.http[m.toLowerCase()];
  if (typeof fn !== "function") throw new Error("当前工具不支持 HTTP 方法: " + m);
  const headers = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  let body;
  if (jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(jsonBody);
  }
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
    throw new Error("请求异常: " + errorMessage(e));
  }
  const status = Number(resp.status || 0);
  const text = await resp.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { status, data, text };
}

/* ---------------- 业务逻辑 ---------------- */
function makeResult(code, status, message) {
  log("[" + code + "] " + ({ success: "✅ 成功", already: "🟡 已在池中", fail: "❌ 失败" }[status] || status) + " | " + message);
  return { code, status, message, time: formatTime() };
}

async function queryCode(ctx, t, code) {
  try {
    const r = await apiRequest(ctx, "GET", t.baseUrl + "/api/codes/" + encodeURIComponent(code), undefined, t);
    if (r.status === 200 && r.data && typeof r.data === "object") return { ok: true, data: r.data };
    return { ok: false, detail: "HTTP " + r.status };
  } catch (e) {
    return { ok: false, detail: errorMessage(e) };
  }
}

async function submitCode(ctx, t, code) {
  const r = await apiRequest(ctx, "POST", t.baseUrl + "/api/codes", { code: code }, t);
  if (r.status >= 200 && r.status < 300) {
    const msg = r.data && r.data.message ? String(r.data.message) : "";
    return { ok: true, message: msg };
  }
  const msg = r.data && r.data.message
    ? String(r.data.message).replace(/[\r\n]+/g, " ").slice(0, 160)
    : "HTTP " + r.status;
  return { ok: false, message: msg };
}

async function processOne(ctx, t, code) {
  if (!CODE_RE.test(code)) {
    return makeResult(code, "fail", "格式不正确（必须是 6 位英文或数字），已跳过");
  }
  const q = await queryCode(ctx, t, code);
  if (q.ok && q.data.active) {
    const n = q.data.copy_count;
    return makeResult(code, "already",
      "已在兑换池中展示" + (n != null ? "（已被复制 " + n + " 次）" : "") + "，本次无需重复提交");
  }
  if (!q.ok) log("[" + code + "] 查询状态失败（" + q.detail + "），继续尝试提交");
  let s;
  try {
    s = await submitCode(ctx, t, code);
  } catch (e) {
    return makeResult(code, "fail", "提交请求异常: " + errorMessage(e));
  }
  if (s.ok) {
    return makeResult(code, "success",
      "提交成功，兑换码已加入兑换池" + (s.message ? "（" + s.message + "）" : ""));
  }
  return makeResult(code, "fail", "提交失败: " + s.message);
}

function buildSummary(results) {
  return results.map((r) => {
    const icon = r.status === "fail" ? "❌" : r.status === "already" ? "🟡" : "✅";
    return icon + " " + r.code + "\n" + r.message;
  }).join("\n\n");
}

/* ---------------- 入口（Egern Schedule 脚本） ---------------- */
export default async function (ctx) {
  try {
    log("czlab 兑换码每日分享启动");
    const t = getRuntimeConfig(ctx);
    const codes = collectCodes(ctx);
    if (!codes.length) {
      notify(ctx, "czlab 兑换码分享失败",
        "未检测到兑换码配置：请在模块设置中填写 CZLAB_CODE（6 位兑换码），或在脚本 CONFIG 中填写 code");
      return;
    }
    const results = [];
    for (const c of codes) {
      results.push(await processOne(ctx, t, c));
    }
    notify(ctx, "czlab 兑换码分享", buildSummary(results));
  } catch (e) {
    log("脚本异常: " + errorMessage(e));
    notify(ctx, "czlab 兑换码分享异常", errorMessage(e));
  }
}
