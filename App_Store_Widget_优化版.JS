// AppStore 内购限免小组件（优化版）
// 数据源：api.zxki.cn / api.03k.org
// 模块设置（可选）：extraApis=备用接口(逗号分隔) / timeoutMs=单次超时毫秒 / maxItems=显示条数
//
// 相对原版的优化：
// 1. 多源并行请求，首个有效结果即用（原版串行 8s+8s，经常被系统超时杀掉）
// 2. 先校验响应是否为 JSON：接口返回非 JSON（如 zxki 已 302 跳转到图片）直接判失败、不重试
// 3. 超时/网络抖动自动重试 1 次；取数总耗时上限 15s，绝不拖死小组件进程
// 4. 首个有效结果后再等 1.5s，把其它源的结果合并去重（列表更全）
// 5. 全部失败时降级显示过期缓存（标题标注"旧数据"），不再直接显示空白
// 6. 标题时间显示数据的实际获取时间，缓存数据一目了然
// 7. 缓存 key 沿用原版（ithome_cache），旧缓存可直接复用

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
      backgroundColor: { light: '#FFFFFF', dark: '#2C2C2E' },
      children: [{
        type: 'text',
        text: '请使用中号或大号组件',
        font: { size: 'callout' },
        textColor: { light: '#1D1D1F', dark: '#F5F5F7' },
        textAlign: 'center'
      }]
    };
  }

  const TIMEOUT_MS = parseInt(ctx.env?.timeoutMs) || 6000;  // 单次请求超时
  const DEADLINE_MS = 15000;                                 // 取数总耗时上限
  const CACHE_TTL = 24 * 60 * 60 * 1000;                     // 缓存"新鲜"期限

  const apis = [
    { url: 'https://api.zxki.cn/api/appfree', parse: parseZXKI },
    { url: 'https://api.03k.org/app/free', parse: parseGeneric }
  ];
  // 允许追加备用源：模块设置 extraApis = "https://a.com/x, https://b.com/y"
  const extra = String(ctx.env?.extraApis || '').split(',')
    .map(s => s.trim()).filter(Boolean);
  for (const url of extra) apis.push({ url, parse: parseGeneric });

  // 并行取数：首个有效结果即用，附带 1.5s 合并窗口
  let apps = await fetchFirstValid(ctx, apis, TIMEOUT_MS, DEADLINE_MS);
  let source = 'api';
  let dataTime = Date.now();

  if (!apps) {
    // 全部失败：降级用缓存（即使超过 24h，也比空白强）
    const cached = readCache(ctx);
    if (cached) {
      apps = cached.apps;
      dataTime = cached.time;
      source = (Date.now() - cached.time <= CACHE_TTL) ? 'cache' : 'stale';
    } else {
      apps = [];
      source = 'none';
    }
  } else {
    writeCache(ctx, apps, dataTime);
  }

  return buildWidget(apps.slice(0, maxItems), source, dataTime);
}

// ============ 数据获取 ============

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 并行请求所有源：首个非空结果即用，再给其它源 1.5s 合并；总耗时不超过 deadline
async function fetchFirstValid(ctx, apis, timeoutMs, deadlineMs) {
  const collected = [];
  let finished = false;
  let graceTimer = null;
  const finish = () => {
    finished = true;
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  };
  const deadlineTimer = setTimeout(finish, deadlineMs);
  const deadlineAt = Date.now() + deadlineMs;

  const tryOne = async (api) => {
    for (let attempt = 1; attempt <= 2 && !finished; attempt++) {
      try {
        // 即使平台忽略 timeout 参数，总耗时也绝不超过 deadline
        const remain = Math.max(1, deadlineAt - Date.now());
        const apps = await Promise.race([
          fetchApi(ctx, api, timeoutMs),
          sleep(remain).then(() => { throw new Error('deadline'); })
        ]);
        if (apps.length > 0) {
          collected.push(apps);
          // 首个有效结果后，再等 1.5s 让其它源的结果进来合并
          if (!graceTimer && !finished) graceTimer = setTimeout(finish, 1500);
          return;
        }
      } catch (e) {
        // 致命错误（如返回的不是 JSON）不重试，直接换源
        if (e && e.fatal) return;
      }
      if (attempt < 2 && !finished) await sleep(600);
    }
  };

  await Promise.all([
    Promise.all(apis.map(tryOne)),
    (async () => { while (!finished) await sleep(50); })()
  ]);
  clearTimeout(deadlineTimer);
  if (graceTimer) clearTimeout(graceTimer);

  if (collected.length === 0) return null;
  return dedupe(collected.flat());
}

// 单次请求：校验 HTTP 状态与 JSON 有效性
async function fetchApi(ctx, api, timeoutMs) {
  const resp = await ctx.http.get(api.url, { timeout: timeoutMs });

  const status = resp.status != null ? resp.status : resp.statusCode;
  if (status && status >= 400) {
    throw new Error('http ' + status);
  }

  let json = null;
  try {
    json = await resp.json();
  } catch (e) {
    // 接口返回的不是 JSON（实测 zxki 已 302 跳转到一张图片）——致命，不重试
    const err = new Error('not json');
    err.fatal = true;
    throw err;
  }
  if (!json || typeof json !== 'object') {
    const err = new Error('bad json');
    err.fatal = true;
    throw err;
  }
  return api.parse(json);
}

// 多源结果合并去重（按名称归一化）
function dedupe(apps) {
  const seen = new Set();
  return apps.filter(a => {
    const key = String(a.name || '').toLowerCase().replace(/\s+/g, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============ 缓存 ============

const CACHE_KEY = 'ithome_cache';            // 沿用原版 key，旧缓存可直接复用
const CACHE_TIME_KEY = 'ithome_cache_time';

function readCache(ctx) {
  try {
    const apps = ctx.storage.getJSON(CACHE_KEY);
    const t = parseInt(ctx.storage.get(CACHE_TIME_KEY) || '0', 10);
    if (Array.isArray(apps) && apps.length > 0 && t > 0) return { apps, time: t };
  } catch (e) {}
  return null;
}

function writeCache(ctx, apps, time) {
  try {
    ctx.storage.setJSON(CACHE_KEY, apps);
    ctx.storage.set(CACHE_TIME_KEY, String(time));
  } catch (e) {}
}

// ============ 解析 ============

// 名称清理（两处解析共用）
function cleanName(raw) {
  let name = String(raw || '').trim();
  if (!name) return '';
  name = name.replace(/\/\//g, ' — ');
  name = name.replace(/\s*\[.*?\]/g, '');
  const httpsIndex = name.toLowerCase().lastIndexOf('http');
  if (httpsIndex !== -1) {
    name = name.substring(0, httpsIndex).trim();
  }
  name = name.replace(/[\s—]+$/, '').trim();
  if (name.length > 50) {
    name = name.substring(0, 50).trim() + '...';
  }
  return name;
}

function appUrl(item, name) {
  const searchName = name.split(' — ')[0].trim();
  return item.url || item.link || `https://apps.apple.com/search?term=${encodeURIComponent(searchName)}`;
}

// 解析 zxki.cn API
function parseZXKI(json) {
  const apps = [];
  if (json.apps) {
    for (const cat in json.apps) {
      const items = json.apps[cat];
      if (Array.isArray(items)) {
        items.forEach(item => {
          const name = cleanName(item.name);
          if (name) apps.push({ name, url: appUrl(item, name), isFree: true });
        });
      }
    }
  }
  return apps;
}

// 解析通用 API
function parseGeneric(json) {
  const apps = [];
  const items = json.data || json;
  if (Array.isArray(items)) {
    items.forEach(item => {
      const name = cleanName(item.name || item.title);
      if (name) apps.push({ name, url: appUrl(item, name), isFree: true });
    });
  }
  return apps;
}

// ============ 构建组件 ============

function buildWidget(apps, source, dataTime) {
  const children = [];

  // 标题时间 = 数据的实际获取时间（缓存数据也能看出来）
  const d = new Date(dataTime);
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const badge = source === 'cache' ? ' · 缓存' : source === 'stale' ? ' · 旧数据' : '';

  // 标题行：左侧标题 + 右侧时间
  children.push({
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    padding: [0, 0, 6, 0],
    children: [
      {
        type: 'text',
        text: `🎁 iOS 内购限免 · ${apps.length}款${badge}`,
        font: { size: 'subheadline', weight: 'bold' },
        textColor: { light: '#1D1D1F', dark: '#F5F5F7' },
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
            color: { light: '#86868B', dark: '#8E8E93' }
          },
          {
            type: 'text',
            text: timeStr,
            font: { size: 'caption2' },
            textColor: { light: '#86868B', dark: '#8E8E93' }
          }
        ]
      }
    ]
  });

  // 空状态
  if (apps.length === 0) {
    children.push({
      type: 'text',
      text: '暂无限免应用\n\n所有数据源均不可用\n请检查网络或稍后再试',
      font: { size: 'callout' },
      textColor: { light: '#666', dark: '#AAA' },
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
          backgroundColor: { light: 'rgba(0,0,0,0.08)', dark: 'rgba(255,255,255,0.12)' },
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
            font: { size: 'subheadline' },
            textColor: { light: '#1D1D1F', dark: '#F5F5F7' },
            flex: 1,
            maxLines: 2,
            minScale: 0.85
          },
          {
            type: 'text',
            text: '限免',
            font: { size: 'caption2', weight: 'semibold' },
            textColor: '#34C759',
            maxLines: 1
          },
          {
            type: 'image',
            src: 'sf-symbol:chevron.right',
            width: 12,
            height: 12,
            color: { light: '#86868B', dark: '#8E8E93' }
          }
        ]
      });
    });
  }

  return {
    type: 'widget',
    padding: [10, 12, 10, 12],
    gap: 4,
    backgroundColor: { light: '#FFFFFF', dark: '#2C2C2E' },
    refreshAfter: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    children: children
  };
}
