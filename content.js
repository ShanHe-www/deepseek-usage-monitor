/**
 * content.js — 数据采集引擎（运行于 platform.deepseek.com 页面）
 *
 * 复用用户已登录的会话（userToken）直接请求后台私有接口，把每个历史月份的
 * 用量明细抓取并存入本地数据库。真实接口：
 *
 *   导出 ZIP：GET https://platform.deepseek.com/api/v0/usage/export
 *              ?start=<utc>&end=<utc>&tz=0      → 内含 amount-*.csv（长表）
 *   明细 JSON：GET /api/v0/usage/amount?month=&year= （当 CSV 导出不可用时兜底）
 *
 * 认证：Authorization: Bearer <userToken>（存在 localStorage 的 userToken）
 */

'use strict';

// 仅同源（background 的 fetch 默认不带页面凭据，content 同源 fetch 才带 cookie/token）
const API_ORIGIN = 'https://platform.deepseek.com';
const DEEPSEEK_MIN_YEAR = 2024;

// ---------------------------------------------------------------------------
// Token 提取：userToken 值可能是 JSON 包裹 / 带引号 / 纯字符串，
// 参考 CodexBar 的实现做健壮解析（≥20 字符、无空白才算"像 token"）。
// ---------------------------------------------------------------------------
function plausibleToken(v) {
  v = String(v == null ? '' : v).trim();
  return v.length >= 20 && !/\s/.test(v);
}

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// 从 localStorage 的一个原始值里尽力提取真正的 token
function extractFromValue(raw) {
  raw = String(raw == null ? '' : raw).trim();
  if (!raw) return null;
  // 情况1：JSON（字符串或对象 {"value":...} / {"token":...} / {"userToken":...}）
  try {
    const obj = JSON.parse(raw);
    if (typeof obj === 'string') {
      const t = unquote(obj).trim();
      if (plausibleToken(t)) return t;
    } else if (obj && typeof obj === 'object') {
      for (const k of ['value', 'token', 'access_token', 'accessToken', 'userToken']) {
        if (typeof obj[k] === 'string') {
          const t = obj[k].trim();
          if (plausibleToken(t)) return t;
        }
      }
    }
  } catch (e) { /* 不是 JSON */ }
  // 情况2：带引号的字符串
  const t = unquote(raw).trim();
  if (plausibleToken(t)) return t;
  return null;
}

function extractToken() {
  try {
    // 优先读官方字段（按常见程度排列）
    const lks = ['userToken', 'user_token', 'token', 'access_token', 'auth_token', 'user'];
    for (const k of lks) {
      const v = localStorage.getItem(k);
      if (v) {
        const t = extractFromValue(v);
        if (t) return t;
      }
    }
    // 兜底：扫描所有 storage 值，优先 eyJ/sk- 开头的疑似 token
    const scan = (storage) => {
      let best = null;
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        const v = storage.getItem(k);
        const t = extractFromValue(v);
        if (!t) continue;
        if (/^eyJ/i.test(t)) return t; // JWT 优先级最高
        if (/^sk-/i.test(t) && !best) best = t;
        if (!best) best = t;
      }
      return best;
    };
    return scan(localStorage) || scan(sessionStorage);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 抓取单个月份：优先 ZIP 导出，失败回退到 amount JSON。
// 返回 { month, records:[{id, month, utc_date, model, api_key_name, type, amount, price, cost}], raw }
// ---------------------------------------------------------------------------
async function fetchMonth(year, month, token, log) {
  const now = new Date();
  const isCurrent = year === now.getFullYear() && month === now.getMonth() + 1;

  const start = Math.floor(Date.UTC(year, month - 1, 1) / 1000);
  const end = Math.floor(Date.UTC(year, month, 1) / 1000);

  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json, text/csv, application/octet-stream, */*',
  };

  // 1) ZIP 导出（优先）
  const zipUrl = `${API_ORIGIN}/api/v0/usage/export?start=${start}&end=${end}&tz=0`;
  try {
    const resp = await fetch(zipUrl, { headers, credentials: 'include' });
    if (resp.status === 200) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      // 空 body 或非 ZIP（可能返回 JSON 错误）
      if (buf.byteLength > 0 && buf[0] === 0x50 && buf[1] === 0x4b) {
        const csvText = extractAmountCsvFromZip(buf);
        if (csvText) {
          const rows = DsCSV.parseDeepSeekCSV(csvText);
          const records = rows.map((r) => buildRecord(monthKey(year, month), r));
          return { month: monthKey(year, month), records, raw: csvText, source: 'zip' };
        }
        if (log) log('⚠️ ZIP 内未找到 amount-*.csv');
      } else {
        // 可能是错误 JSON
        const text = await resp.text().catch(() => '');
        if (/"(code|msg|message|error)"/.test(text)) {
          const err = parseErrJson(text);
          if (err && isAuthError(err.code)) {
            return { month: monthKey(year, month), records: [], authFailed: true };
          }
        }
        if (log) log(`⚠️ ${monthKey(year, month)} 导出非 ZIP（HTTP ${resp.status}），尝试 JSON 兜底`);
      }
    } else if (resp.status === 401 || resp.status === 403) {
      return { month: monthKey(year, month), records: [], authFailed: true };
    }
  } catch (e) {
    if (log) log(`⚠️ ZIP 导出失败（${e.message}），尝试 JSON 兜底`);
  }

  // 2) amount JSON 兜底（/api/v0/usage/amount?month=&year=）
  const amountUrl = `${API_ORIGIN}/api/v0/usage/amount?month=${month}&year=${year}`;
  try {
    const resp = await fetch(amountUrl, { headers, credentials: 'include' });
    if (resp.status === 200) {
      const json = await resp.json().catch(() => null);
      const rows = extractAmountJsonRows(json);
      const records = rows.map((r) => buildRecord(monthKey(year, month), r));
      return { month: monthKey(year, month), records, raw: '', source: 'json' };
    } else if (resp.status === 401 || resp.status === 403) {
      return { month: monthKey(year, month), records: [], authFailed: true };
    }
  } catch (e) {
    // fallthrough
  }

  // 兜底也失败：记录为空（不要中断整个同步）
  return { month: monthKey(year, month), records: [], raw: '', source: 'none' };
}

function monthKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function isAuthError(code) {
  return String(code) === '40002' || String(code) === '40003' ||
    String(code) === '400' || String(code) === '401' ||
    String(code) === '403';
}

function parseErrJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/**
 * 从 ZIP（Uint8Array）中提取第一个 amount-*.csv 的文本。
 * 使用 fflate（lib/fflate.umd.js），content script 中通过 chrome.scripting 注入。
 */
function extractAmountCsvFromZip(buf) {
  const fflate = self.fflate;
  if (!fflate) {
    console.warn('[DeepSeek 用量全史] fflate 未加载，无法解压 ZIP');
    return null;
  }
  let files;
  try {
    files = fflate.unzipSync(buf);
  } catch (e) {
    console.warn('[DeepSeek 用量全史] 解压失败:', e.message);
    return null;
  }
  const names = Object.keys(files || {});
  const amountName = names.find((n) => /amount[^/]*\.csv$/i.test(n));
  if (!amountName) return null;
  const bytes = files[amountName];
  if (!bytes) return null;
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch (e) {
    return null;
  }
}

/**
 * amount JSON 兜底解析。
 * 结构（参考多个开源实现）：
 *   { code:0, data:{ biz_code:0, biz_data:[ { total:[ { model, usage:[{type,amount}] } ] } ] } }
 *   type: PROMPT_TOKEN / PROMPT_CACHE_HIT_TOKEN / PROMPT_CACHE_MISS_TOKEN /
 *         RESPONSE_TOKEN / REQUEST
 * 可能含 date 字段（"YYYY-MM-DD"）或仅月度 TOTAL。
 */
function extractAmountJsonRows(json) {
  if (!json || json.code !== 0) return [];
  const out = [];
  const walk = (node, inheritedDate, model) => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x, inheritedDate, model);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (typeof node.model === 'string' && Array.isArray(node.usage)) {
      const date = inheritedDate || 'TOTAL';
      for (const u of node.usage) {
        if (!u || typeof u.type !== 'string') continue;
        const amt = typeof u.amount === 'number' ? u.amount : parseFloat(String(u.amount ?? '0'));
        out.push({
          utc_date: date === 'TOTAL' ? 'TOTAL' : String(date).slice(0, 10),
          model: node.model,
          api_key_name: node.api_key_name || 'default',
          type: normJsonType(u.type),
          amount: isNaN(amt) ? 0 : amt,
          price: 0,
        });
      }
      return;
    }
    const dateCandidate =
      (typeof node.date === 'string' && node.date) ||
      (typeof node.day === 'string' && node.day) ||
      (typeof node.ds === 'string' && node.ds) ||
      (typeof node.report_date === 'string' && node.report_date) ||
      undefined;
    const passedDate = dateCandidate ? String(dateCandidate).slice(0, 10) : inheritedDate;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'total' && Array.isArray(v)) {
        // total 数组下通常是 [{ model, usage }]，直接作为叶子处理
        for (const item of v) walk(item, passedDate, model);
      } else {
        walk(v, passedDate, model);
      }
    }
  };
  walk(json.data, undefined, undefined);
  return out;
}

function normJsonType(t) {
  const map = {
    PROMPT_TOKEN: 'input_cache_miss_tokens',
    PROMPT_CACHE_HIT_TOKEN: 'input_cache_hit_tokens',
    PROMPT_CACHE_MISS_TOKEN: 'input_cache_miss_tokens',
    RESPONSE_TOKEN: 'output_tokens',
    COMPLETION_TOKEN: 'output_tokens',
    REQUEST: 'request_count',
    PROMPT_CACHE_HIT_TOKENS: 'input_cache_hit_tokens',
    PROMPT_CACHE_MISS_TOKENS: 'input_cache_miss_tokens',
  };
  return map[String(t).toUpperCase()] || String(t).toLowerCase();
}

/**
 * 把一行原始数据转成入库记录。id 由月份+日期+模型+key+type 组成，
 * 保证同一单元格重复抓取幂等。
 */
function buildRecord(month, r) {
  const type = DsCSV.normType(r.type) || r.type || 'unknown';
  // 费用 = 单价 × 用量（仅当有单价时；request_count 行通常无单价）
  const cost = r.price && isFinite(r.price) && r.price > 0 ? r.amount * r.price : (r.cost || 0);
  return {
    id: `${month}::${r.utc_date || 'TOTAL'}::${r.model}::${r.api_key_name}::${type}`,
    month: month,
    utc_date: r.utc_date || '',
    model: r.model,
    api_key_name: r.api_key_name,
    type: type,
    amount: r.amount || 0,
    price: r.price || 0,
    cost: cost,
  };
}

// ---------------------------------------------------------------------------
// 主同步流程：逐月拉取 → 去重入库
// ---------------------------------------------------------------------------
async function syncAllData(opts = {}) {
  const { fromYear = DEEPSEEK_MIN_YEAR, fromMonth = 1, log } = opts;
  const token = extractToken();
  if (!token) {
    return { ok: false, error: 'no_token', message: '未找到登录凭证，请先在 DeepSeek 后台登录。' };
  }

  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;

  // 已同步月份（增量：已有月份的记录会被幂等更新，无需整月重拉）
  let synced = [];
  let attempted = [];
  try {
    const res = await chrome.runtime.sendMessage({ action: 'queryRecords' });
    if (res && res.ok) {
      const set = new Set((res.records || []).map((r) => r.month));
      synced = Array.from(set);
    }
    const meta = await chrome.runtime.sendMessage({ action: 'getMeta', key: 'attempted_months' });
    if (meta && meta.ok && Array.isArray(meta.value)) attempted = meta.value;
  } catch (e) { /* ignore */ }
  const syncedSet = new Set(synced);
  const attemptedSet = new Set(attempted);

  const months = [];
  for (let y = fromYear; y <= curY; y++) {
    const sM = (y === fromYear) ? fromMonth : 1;
    const eM = (y === curY) ? curM : 12;
    for (let m = sM; m <= eM; m++) months.push({ y, m });
  }

  let totalAdded = 0, totalUpdated = 0, authFailed = false, emptyMonths = 0;
  const startMs = Date.now();
  let done = 0;
  const progress = (msg) => {
    if (log) log(msg);
  };

  // 抓取并入库单个月份，返回 { authFailed, added, updated, empty }
  async function fetchOneMonth(y, m) {
    const key = monthKey(y, m);
    const res = await fetchMonth(y, m, token, (msg) => progress(`[${key}] ${msg}`));
    done++;
    if (res.authFailed) {
      await chrome.runtime.sendMessage({ action: 'setMeta', key: 'attempted_months', value: [] }).catch(() => {});
      return { authFailed: true };
    }
    if (res.records && res.records.length) {
      const saved = await chrome.runtime.sendMessage({ action: 'saveRecords', records: res.records });
      if (saved && saved.ok) {
        totalAdded += saved.added || 0;
        totalUpdated += saved.updated || 0;
      }
      progress(`✅ ${key}：${res.records.length} 条明细（新增 ${saved ? saved.added : 0}）`);
      return { added: saved ? saved.added : 0, updated: saved ? saved.updated : 0 };
    }
    emptyMonths++;
    attempted.push(key);
    progress(`· ${key}：无数据`);
    return { empty: true };
  }

  progress(`开始同步 ${months.length} 个月份…`);

  for (const { y, m } of months) {
    const key = monthKey(y, m);
    const isCurrent = (y === curY && m === curM);
    // 已同步或已尝试（无数据）的过去月份：跳过，避免每次重复拉取
    if (!isCurrent && (syncedSet.has(key) || attemptedSet.has(key))) {
      done++;
      continue;
    }
    const r = await fetchOneMonth(y, m);
    if (r.authFailed) {
      authFailed = true;
      progress(`⛔ ${key}：认证失败，请检查是否已登录。`);
      break;
    }
    // 控制请求节奏
    await new Promise((r2) => setTimeout(r2, 250));
  }

  await chrome.runtime.sendMessage({
    action: 'setMeta',
    key: 'last_sync',
    value: { at: new Date().toISOString(), added: totalAdded, updated: totalUpdated, months: months.length },
  });
  if (attempted.length) {
    await chrome.runtime.sendMessage({ action: 'setMeta', key: 'attempted_months', value: attempted });
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  return {
    ok: !authFailed,
    totalAdded,
    totalUpdated,
    emptyMonths,
    months: months.length,
    authFailed,
    elapsed,
  };
}

// ---------------------------------------------------------------------------
// 同步当前月份（用于打开弹窗时静默自动更新，不打扰用户）
// ---------------------------------------------------------------------------
async function syncMonth(monthKeyStr, opts = {}) {
  const { log } = opts;
  const token = extractToken();
  if (!token) return { ok: false, error: 'no_token' };

  const [y, m] = monthKeyStr.split('-').map(Number);
  const res = await fetchMonth(y, m, token, (msg) => { if (log) log(msg); });
  if (res.authFailed) return { ok: false, authFailed: true };
  if (res.records && res.records.length) {
    const saved = await chrome.runtime.sendMessage({ action: 'saveRecords', records: res.records });
    if (saved && saved.ok) return { ok: true, added: saved.added || 0, updated: saved.updated || 0, count: res.records.length };
  }
  // 当月无数据也记录"已尝试"，避免下次打开弹窗重复拉取
  if (!(res.records && res.records.length)) {
    try {
      const meta = await chrome.runtime.sendMessage({ action: 'getMeta', key: 'attempted_months' });
      const list = (meta && meta.ok && Array.isArray(meta.value)) ? meta.value : [];
      if (!list.includes(monthKeyStr)) list.push(monthKeyStr);
      await chrome.runtime.sendMessage({ action: 'setMeta', key: 'attempted_months', value: list });
    } catch (e) { /* ignore */ }
  }
  return { ok: true, added: 0, updated: 0, count: 0 };
}

// ---------------------------------------------------------------------------
// 诊断：返回当前页面环境的关键信息，帮助定位"为什么同步不到数据"
// ---------------------------------------------------------------------------
async function diagnose() {
  const token = extractToken();
  const report = {
    onPage: typeof location !== 'undefined' && location.host === 'platform.deepseek.com',
    loggedIn: !!token,
    tokenFound: token ? token.slice(0, 12) + '…(' + token.length + '字)' : null,
    tokenSource: null,
    localKeys: [],
    cookieNames: [],
    exportCheck: null,
    summaryCheck: null,
    currentMonth: monthKey(new Date().getFullYear(), new Date().getMonth() + 1),
  };
  // 记录有哪些 localStorage key 看起来像 token（只记录 key 名，不泄露值）
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k);
      if (v && extractFromValue(v)) report.localKeys.push(k);
    }
  } catch (e) {}
  // cookie 名（不含值）
  try {
    document.cookie.split(';').forEach((c) => {
      const name = c.trim().split('=')[0];
      if (name && !report.cookieNames.includes(name)) report.cookieNames.push(name);
    });
  } catch (e) {}

  if (!token) return report;

  // 用当前月份测试 export 接口（只探测，不解析）
  const now = new Date();
  const start = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), 1) / 1000);
  const end = Math.floor(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1) / 1000);
  const url = `${API_ORIGIN}/api/v0/usage/export?start=${start}&end=${end}&tz=0`;
  try {
    const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, credentials: 'include' });
    const buf = new Uint8Array(await resp.arrayBuffer());
    report.exportCheck = {
      status: resp.status,
      bytes: buf.byteLength,
      isZip: buf.byteLength > 2 && buf[0] === 0x50 && buf[1] === 0x4b,
      note: resp.status === 401 ? '认证失败' : resp.status === 200 ? (buf.byteLength > 2 ? 'OK' : '空响应') : '非预期状态',
    };
  } catch (e) {
    report.exportCheck = { status: 'network_error', note: e.message };
  }

  // 测 summary（更轻量）
  try {
    const resp = await fetch(`${API_ORIGIN}/api/v0/users/get_user_summary`, {
      headers: { Authorization: 'Bearer ' + token },
      credentials: 'include',
    });
    const text = await resp.text().catch(() => '');
    report.summaryCheck = { status: resp.status, body: text.slice(0, 160) };
  } catch (e) {
    report.summaryCheck = { status: 'network_error', note: e.message };
  }
  return report;
}

// ---------------------------------------------------------------------------
// 消息监听（popup / background 通过 chrome.tabs.sendMessage 调用）
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'ping') {
    sendResponse({ pong: true });
    return false;
  }
  if (msg && msg.action === 'diagnose') {
    diagnose().then(sendResponse).catch((e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  }
  if (msg && msg.action === 'sync') {
    syncAllData({ log: msg.onProgress ? (m) => {
      try { chrome.runtime.sendMessage({ action: 'syncProgress', message: m }); } catch (e) {}
    } : undefined })
      .then(sendResponse);
    return true;
  }
  if (msg && msg.action === 'syncMonth') {
    syncMonth(msg.month || monthKey(new Date().getFullYear(), new Date().getMonth() + 1))
      .then(sendResponse);
    return true;
  }
  if (msg && msg.action === 'extractToken') {
    sendResponse({ token: extractToken() });
    return true;
  }
  return false;
});
