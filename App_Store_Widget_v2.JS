// AppStore 美区限免小组件（优化版 v2）
// 基于 IBL3ND/App_Store_Widget.JS 重写
//
//
// 原版只有两个数据源，且都已失效：
// 1. api.zxki.cn/api/appfree —— 已下线，现在 302 跳转到一张 JPG 图片
// 2. api.03k.org/app/free —— 域名已无法连接
//
// （2026-10-10 实测）
// 1. AppRaven GraphQL 取近期调价动态（appsOnSale）
// 注意：这个接口返回的是"降价"动态，不全是免费，必须过滤 priceTierTo == 0
// 2. 用 Apple 官方 iTunes Lookup 接口批量验证美区现价（一次请求最多 200 个 ID）
// 只有 country=US 下 price == 0 的才算真限免 —— 防止展示"已涨回去"的应用
// 3. 全部失败时读 24 小时缓存兜底
//
// 用法：把本文件传到你的 GitHub 仓库，用 raw 链接替换 Egern 小组件的脚本 URL。

export default async function(ctx) {
const widgetFamily = ctx.widgetFamily || 'systemMedium';

let maxItems = 7;
if (widgetFamily === 'systemLarge') {
maxItems = 12;
}
maxItems = parseInt(ctx.env?.maxItems) || maxItems;

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
const CACHE_KEY = 'appfree_us_v2';
const CACHE_TIME_KEY = 'appfree_us_v2_time';
const CACHE_TTL = 24 * 60 * 60 * 1000;

let apps = [];
let fromCache = false;
let cacheTime = 0;

try {
apps = await fetchVerifiedFreeApps(ctx, UA, 'US');
console.log(`美区限免：验证通过 ${apps.length} 款`);
} catch (e) {
console.log('主链路失败:', e.message);
}

if (apps.length > 0) {
try {
ctx.storage.setJSON(CACHE_KEY, apps);
ctx.storage.set(CACHE_TIME_KEY, Date.now().toString());
} catch (e) { /* ignore */}
} else {
const cached = readCache(ctx, CACHE_KEY, CACHE_TIME_KEY, CACHE_TTL);
if (cached) {
apps = cached.apps;
fromCache = true;
cacheTime = cached.time;
console.log(`使用缓存，共 ${apps.length} 款`);
}
}

return buildWidget(apps.slice(0, maxItems), fromCache, cacheTime, '🎁 美区限免');
};

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

// ============ 数据链路 ============

// 拉取 AppRaven 调价动态 → 过滤降到免费 → iTunes Lookup 批量验证现价
async function fetchVerifiedFreeApps(ctx, UA, country) {
const query = `query WidgetSale($page: Int!, $pageSize: Int!) {
appsOnSale(rareOnly: false, miniFilter: {ratingCount: 10}, page: $page, pageSize: $pageSize) {
content {
id
timestamp
app { id title ITunesId}
... on AppActivityPriceChange { priceChangeType: type priceTierFrom priceTierTo}
}
}
}`;

// 两页并行拉取近期动态
const pages = await Promise.all([0, 1, 2].map(page =>
ctx.http.post('https://appraven.net/appraven/graphql', {
timeout: 12000,
headers: {
'Content-Type': 'application/json',
'Accept': 'application/json',
'User-Agent': UA,
},
body: JSON.stringify({ query, variables: { page, pageSize: 30}}),
}).then(async (resp) => {
const status = Number(resp.status || 0);
if (status < 200 || status >= 300) throw new Error('AppRaven HTTP ' + status);
const json = await resp.json();
if (json.errors) throw new Error('GraphQL: ' + JSON.stringify(json.errors).slice(0, 100));
const items = json?.data?.appsOnSale?.content;
return Array.isArray(items)? items: [];
})
));

// 只保留"降到免费"（priceTierTo == 0）的条目，去重
const seen = new Set();
const freeIds = [];
for (const items of pages) {
for (const it of items) {
if (it.priceTierTo!== 0) continue; // 只是降价、没免费 → 不要
const app = it.app || {};
const tid = app.ITunesId? String(app.ITunesId): '';
if (tid &&!seen.has(tid)) {
seen.add(tid);
freeIds.push(tid);
}
}
}
if (freeIds.length === 0) return [];
console.log(`AppRaven 发现降到免费: ${freeIds.length} 款`);

// Apple 官方接口批量验证该区现价（一次最多 200 个）
const resp = await ctx.http.get(
`https://itunes.apple.com/lookup?id=${freeIds.slice(0, 100).join(',')}&country=${country}`,
{ timeout: 12000, headers: { 'Accept': 'application/json', 'User-Agent': UA}}
);
const status = Number(resp.status || 0);
if (status < 200 || status >= 300) throw new Error('iTunes Lookup HTTP ' + status);
const data = await resp.json();

// 按发现顺序（最新在前）组装：lookup 返回的顺序是乱的，必须按 ids 的顺序取
const byId = {};
for (const r of (data.results || [])) {
byId[String(r.trackId)] = r;
}
const apps = [];
for (const tid of freeIds.slice(0, 100)) {
const r = byId[tid];
if (!r) continue; // 该区未上架 → 不要
if (Number(r.price)!== 0) continue; // 已涨回去 → 不要
const name = (r.trackName || '').trim(); 
if (!name) continue;
apps.push({
name: name.length > 50? name.substring(0, 50).trim() + '...': name,
url: r.trackViewUrl || `https://apps.apple.com/app/id${r.trackId}`,
kind: 'app',
});
}
return apps;
}

// ============ 构建组件 ============

function buildWidget(apps, fromCache, cacheTime, title) {
const children = [];

const t = fromCache && cacheTime? new Date(cacheTime): new Date();
const timeStr = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
const timeLabel = fromCache? `缓存 ${timeStr}`: timeStr;

children.push({
type: 'stack',
direction: 'row',
alignItems: 'center',
padding: [0, 0, 6, 0],
children: [
{
type: 'text',
text: `${title} · ${apps.length}款`,
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
apps.forEach((app, i) => {
if (i > 0) {
children.push({
type: 'stack',
height: 0.5,
backgroundColor: { light: 'rgba(0,0,0,0.08)', dark: 'rgba(255,255,255,0.12)'},
margin: [4, 0]
});
}
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
text: '限免',
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
