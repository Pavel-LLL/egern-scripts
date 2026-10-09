// AppStore 限免小组件（美区优化版 v2）
// 基于 IBL3ND/App_Store_Widget.JS 重写
//
//
// 原版只有两个数据源，且都已失效：
// 1. api.zxki.cn/api/appfree —— 已下线，现在 302 跳转到一张 JPG 图片
// 2. api.03k.org/app/free —— 域名已无法连接
// 两个源串行请求、一个超时 8 秒，失败后只能读 24 小时缓存，
// 缓存过期就显示"暂无限免应用"。
//
//
// 1. 新增主数据源：AppRaven GraphQL（https://appraven.net/appraven/graphql）
// 匿名可访问，实测数据新鲜（当天限免），返回 iTunesId 可拼直链。
// 2. 三源并行请求（Promise.allSettled），不再串行等待，最慢约 10 秒。
// 3. 每个请求显式检查 HTTP 状态 + 加 UA/Accept 头。
// 4. 结果合并去重：AppRaven 优先，其余源补足。
// 5. 缓存 24 小时保留；命中缓存时标题时间显示为缓存时间（不再误导为"刚刷新"）。
// 6. 应用直链：有 iTunesId 直接拼 apps.apple.com/app/idxxx，无则回退搜索页。
// 7. 区分"应用限免"与"内购限免"两种条目。
//
// 用法：把本文件传到你的 GitHub 仓库，用 raw 链接替换 Egern 小组件的脚本 URL。

export default async function(ctx) {
const widgetFamily = ctx.widgetFamily || 'systemMedium';

// 根据尺寸调整显示数量
let maxItems = 7;
if (widgetFamily === 'systemLarge') {
maxItems = 12;
}
maxItems = parseInt(ctx.env?.maxItems) || maxItems;

// 不支持的尺寸
if (['systemSmall', 'accessoryCircular', 'accessoryInline', 'accessoryRectangular'].includes(widgetFamily)) {
return {
type: 'widget',
padding: 16,
backgroundColor: { light: '#FFFFFF', dark: '#2C2C2E'},
children: [{
type: 'text',
text: '请使用中号或大号组件',
font: { size: 'callout'},
textColor: { light: '#1D1D1F', dark: '#F5F5F7'},
textAlign: 'center'
}]
};
}

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CACHE_KEY = 'appfree_cache_v2';
const CACHE_TIME_KEY = 'appfree_cache_v2_time';
const LEGACY_CACHE_KEY = 'ithome_cache'; // 兼容原版缓存，不浪费已有数据
const CACHE_TTL = 24 * 60 * 60 * 1000;

let apps = [];
let fromCache = false;
let cacheTime = 0;

// ---- 三源并行拉取 ----
const results = await Promise.allSettled([
fetchAppRaven(ctx, UA, Math.max(maxItems, 20)),
fetchLegacy(ctx, UA, 'https://api.zxki.cn/api/appfree', parseZXKI),
fetchLegacy(ctx, UA, 'https://api.03k.org/app/free', parseGeneric),
]);

// 合并去重：AppRaven 优先
const seen = new Set();
for (const r of results) {
if (r.status!== 'fulfilled' ||!Array.isArray(r.value)) continue;
for (const a of r.value) {
const key = (a.name || '').toLowerCase().replace(/\s+/g, '');
if (a.name &&!seen.has(key)) {
seen.add(key);
apps.push(a);
}
}
}
console.log(`限免数据源: AppRaven=${okCount(results[0])} zxki=${okCount(results[1])} 03k=${okCount(results[2])} 合并=${apps.length}`);

// ---- 缓存：写入 / 兜底读取 ----
if (apps.length > 0) {
try {
ctx.storage.setJSON(CACHE_KEY, apps);
ctx.storage.set(CACHE_TIME_KEY, Date.now().toString());
} catch (e) { console.log('写缓存失败:', e.message);}
} else {
const cached = readCache(ctx, CACHE_KEY, CACHE_TIME_KEY, CACHE_TTL)
|| readCache(ctx, LEGACY_CACHE_KEY, 'ithome_cache_time', CACHE_TTL);
if (cached) {
apps = cached.apps;
fromCache = true;
cacheTime = cached.time;
console.log(`使用缓存，共 ${apps.length} 款`);
}
}

return buildWidget(apps.slice(0, maxItems), fromCache, cacheTime);
};

function okCount(r) {
return (r.status === 'fulfilled' && Array.isArray(r.value))? r.value.length: ('ERR:' + (r.reason?.message || r.reason));
}

function readCache(ctx, key, timeKey, ttl) {
try {
const cached = ctx.storage.getJSON(key);
const t = parseInt(ctx.storage.get(timeKey) || '0');
if (cached && cached.length > 0 && t && Date.now() - t < ttl) {
return { apps: cached, time: t};
}
} catch (e) { /* ignore */}
return null;
}

// ============ 数据获取 ============

// 主源：AppRaven GraphQL（匿名可用）
async function fetchAppRaven(ctx, UA, pageSize) {
const url = 'https://appraven.net/appraven/graphql';
const query = `query WidgetSale($pageSize: Int!) {
appsOnSale(rareOnly: false, miniFilter: {ratingCount: 10}, page: 0, pageSize: $pageSize) {
content {
id
app { id title ITunesId}
inAppPurchase { id title app { id title ITunesId}}
}
}
}`;
const resp = await ctx.http.post(url, {
timeout: 12000,
headers: {
'Content-Type': 'application/json',
'Accept': 'application/json',
'User-Agent': UA,
},
body: JSON.stringify({ query, variables: { pageSize}}),
});
const status = Number(resp.status || 0);
if (status < 200 || status >= 300) throw new Error('AppRaven HTTP ' + status);
const json = await resp.json();
if (json.errors) throw new Error('AppRaven GraphQL: ' + JSON.stringify(json.errors).slice(0, 120));
return parseAppRaven(json);
}

// 备用源：原版两个 API（已失效，保留以防恢复）
async function fetchLegacy(ctx, UA, url, parse) {
const resp = await ctx.http.get(url, {
timeout: 10000,
headers: { 'Accept': 'application/json', 'User-Agent': UA},
});
const status = Number(resp.status || 0);
if (status < 200 || status >= 300) throw new Error('HTTP ' + status);
const json = await resp.json();
return parse(json);
}

// ============ 解析 ============

function cleanName(raw) {
let name = (raw || '').trim();
if (!name) return '';
name = name.replace(/\/\//g, ' — ');
name = name.replace(/\s*\[.*?\]/g, '');
const httpsIndex = name.toLowerCase().lastIndexOf('http');
if (httpsIndex!== -1) name = name.substring(0, httpsIndex).trim();
name = name.replace(/[\s—]+$/, '').trim();
if (name.length > 50) name = name.substring(0, 50).trim() + '...';
return name;
}

function appStoreUrl(itunesId, searchName) {
if (itunesId) return `https://apps.apple.com/app/id${itunesId}`;
return `https://apps.apple.com/search?term=${encodeURIComponent(searchName || '')}`;
}

// 解析 AppRaven
function parseAppRaven(json) {
const apps = [];
const items = json?.data?.appsOnSale?.content;
if (!Array.isArray(items)) return apps;
for (const it of items) {
const iap = it.inAppPurchase;
const app = it.app || (iap && iap.app) || {};
const appTitle = (app.title || '').trim();
const iapTitle = (iap && iap.title || '').trim();
if (!appTitle &&!iapTitle) continue;
let name;
if (iapTitle) {
name = cleanName(`${iapTitle}（${appTitle}·内购）`);
} else {
name = cleanName(appTitle);
}
if (!name) continue;
apps.push({
name,
url: appStoreUrl(app.ITunesId, iapTitle || appTitle),
kind: iapTitle? 'iap': 'app',
});
}
return apps;
}

// 解析 zxki.cn API（原版逻辑保留）
function parseZXKI(json) {
const apps = [];
if (json.apps) {
for (const cat in json.apps) {
const items = json.apps[cat];
if (Array.isArray(items)) {
items.forEach(item => {
const name = cleanName(item.name);
if (name) {
const searchName = name.split(' — ')[0].trim();
apps.push({
name,
url: item.url || appStoreUrl(null, searchName),
kind: 'app',
});
}
});
}
}
}
return apps;
}

// 解析通用 API（原版逻辑保留）
function parseGeneric(json) {
const apps = [];
const items = json.data || json;
if (Array.isArray(items)) {
items.forEach(item => {
if (item.name || item.title) {
const name = cleanName(item.name || item.title);
if (name) {
const searchName = name.split(' — ')[0].trim();
apps.push({
name,
url: item.url || item.link || appStoreUrl(null, searchName),
kind: 'app',
});
}
}
});
}
return apps;
}

// ============ 构建组件 ============

function buildWidget(apps, fromCache, cacheTime) {
const children = [];

// 时间显示：实时数据用当前时间，缓存数据用缓存时间并标注
const t = fromCache && cacheTime? new Date(cacheTime): new Date();
const timeStr = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
const timeLabel = fromCache? `缓存 ${timeStr}`: timeStr;

// 标题行：左侧标题 + 右侧时间
children.push({
type: 'stack',
direction: 'row',
alignItems: 'center',
padding: [0, 0, 6, 0],
children: [
{
type: 'text',
text: `🎁 iOS 限免 · ${apps.length}款`,
font: { size: 'subheadline', weight: 'bold'},
textColor: { light: '#1D1D1F', dark: '#F5F5F7'},
flex: 1
},
{
type: 'stack',
direction: 'row',
alignItems: 'center',
gap: 4,
children: [
{
type: 'image',
src: 'sf-symbol:arrow.clockwise',
width: 14,
height: 14,
color: { light: '#86868B', dark: '#8E8E93'}
},
{
type: 'text',
text: timeLabel,
font: { size: 'caption2'},
textColor: { light: '#86868B', dark: '#8E8E93'}
}
]
}
]
});

// 空状态
if (apps.length === 0) {
children.push({
type: 'text',
text: '暂无限免应用\n\n请检查网络或稍后再试',
font: { size: 'callout'},
textColor: { light: '#666', dark: '#AAA'},
textAlign: 'center',
padding: [20, 0]
});
} else {
// 应用列表
apps.forEach((app, i) => {
// 分隔线
if (i > 0) {
children.push({
type: 'stack',
height: 0.5,
backgroundColor: { light: 'rgba(0,0,0,0.08)', dark: 'rgba(255,255,255,0.12)'},
margin: [4, 0]
});
}

// 应用项
children.push({
type: 'stack',
direction: 'row',
alignItems: 'center',
gap: 10,
url: app.url,
padding: [4, 0],
children: [
{
type: 'text',
text: app.name,
font: { size: 'subheadline'},
textColor: { light: '#1D1D1F', dark: '#F5F5F7'},
flex: 1,
maxLines: 2,
minScale: 0.85
},
{
type: 'text',
text: app.kind === 'iap'? '内购': '限免',
font: { size: 'caption2', weight: 'semibold'},
textColor: '#34C759',
maxLines: 1
},
{
type: 'image',
src: 'sf-symbol:chevron.right',
width: 12,
height: 12,
color: { light: '#86868B', dark: '#8E8E93'}
}
]
});
});
}

return {
type: 'widget',
padding: [10, 12, 10, 12],
gap: 4,
backgroundColor: { light: '#FFFFFF', dark: '#2C2C2E'},
refreshAfter: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
children: children
};
}
