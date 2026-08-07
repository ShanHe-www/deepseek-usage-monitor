/* popup.js — DeepSeek 用量全史 · Dashboard 逻辑
   功能：日期范围筛选、趋势/分布图表、可点击热力图、
        每日各模型明细表（按模型 / 按 Key×模型）、按 Key 汇总、导出、诊断、自动同步 */
'use strict';

const els = {
  syncStatus:      document.getElementById('sync-status'),
  totalTokens:     document.getElementById('total-tokens'),
  totalCost:       document.getElementById('total-cost'),
  totalRequests:   document.getElementById('total-requests'),
  cacheRate:       document.getElementById('cache-rate'),
  statActiveDays:  document.getElementById('stat-active-days'),
  apiKeyTable:     document.getElementById('api-key-table').querySelector('tbody'),
  btnSync:         document.getElementById('btn-sync'),
  btnDiagnose:     document.getElementById('btn-diagnose'),
  btnExport:       document.getElementById('btn-export'),
  btnClear:        document.getElementById('btn-clear'),
  lastSync:        document.getElementById('last-sync'),
  heatmap:         document.getElementById('heatmap'),
  trendSeg:        document.getElementById('trend-seg'),
  detailSeg:       document.getElementById('detail-seg'),
  modelSeg:        document.getElementById('model-seg'),
  costSeg:         document.getElementById('cost-seg'),
  modelTitle:      document.getElementById('chart-model-title'),
  detailTitle:     document.getElementById('day-detail-title'),
  detailBody:      document.getElementById('day-detail-body'),
  rangePresets:    document.querySelectorAll('#range-bar .range-presets button'),
  dateStart:       document.getElementById('date-start'),
  dateEnd:         document.getElementById('date-end'),
  btnApplyRange:   document.getElementById('btn-apply-range'),
};

let chartTokens, chartModel, chartCost, chartModelDaily;
let allRecords = [];        // 后台全部明细
let range = { start: null, end: null }; // 'YYYY-MM-DD' 或 null(不限)
let selectedDay = null;     // 当前选中的日期 'YYYY-MM-DD'
let detailGran = 'model';   // model | key
let pieMode = 'usage';      // 模型饼图：usage | cost
let costMode = 'total';     // 每日费用：total（总费用）| model（按模型堆叠）

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return Math.round(n).toLocaleString('en-US'); // 完整千分位，如 109,168,293
}
function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return '--';
  if (Math.abs(n) >= 1000) return '¥' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '¥' + n.toFixed(4).replace(/\.?0+$/, '');
}
function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return n.toFixed(1) + '%';
}
function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}
function toYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}
function fmtDateCn(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}

// ---------------------------------------------------------------------------
// 数据：后台全部明细 → 记录
// ---------------------------------------------------------------------------
async function loadAllRecords() {
  const resp = await chrome.runtime.sendMessage({ action: 'queryRecords' });
  return (resp && resp.ok && resp.records) || [];
}

// 在范围内筛选记录（范围以"天"计，含起止日）
function filterByRange(records) {
  if (!range.start && !range.end) return records;
  return records.filter((r) => {
    const d = r.utc_date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true; // TOTAL 行总是算入（按月份聚合时再归位）
    if (range.start && d < range.start) return false;
    if (range.end && d > range.end) return false;
    return true;
  });
}

// 按天聚合（仅真实日期行）
function aggregateByDay(records) {
  const map = new Map();
  for (const r of records) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.utc_date)) continue;
    let d = map.get(r.utc_date);
    if (!d) { d = { date: r.utc_date, tokens: 0, input: 0, output: 0, cacheHit: 0, cacheMiss: 0, cost: 0, requests: 0 }; map.set(r.utc_date, d); }
    const isIn = r.type === 'input_cache_hit_tokens' || r.type === 'input_cache_miss_tokens';
    const isOut = r.type === 'output_tokens';
    if (isIn) { d.tokens += r.amount; d.input += r.amount; if (r.type === 'input_cache_hit_tokens') d.cacheHit += r.amount; else d.cacheMiss += r.amount; }
    else if (isOut) { d.tokens += r.amount; d.output += r.amount; }
    else if (r.type === 'request_count') d.requests += r.amount;
    d.cost += r.cost || 0;
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// 按天+模型（或 Key×模型）聚合某一天的明细（供每日明细表）
function aggregateDayEntries(records, dateStr, gran) {
  const keyOf = gran === 'key'
    ? (r) => r.api_key_name + '||' + r.model
    : (r) => r.model;
  const labelOf = gran === 'key'
    ? (r) => ({ main: r.api_key_name, sub: shortModel(r.model) })
    : (r) => ({ main: shortModel(r.model), sub: null });
  const map = new Map();
  for (const r of records) {
    if (r.utc_date !== dateStr) continue;
    const k = keyOf(r);
    if (!map.has(k)) {
      map.set(k, { key: k, label: labelOf(r), output: 0, cacheHit: 0, cacheMiss: 0, cost: 0 });
    }
    const e = map.get(k);
    if (r.type === 'output_tokens') e.output += r.amount;
    else if (r.type === 'input_cache_hit_tokens') e.cacheHit += r.amount;
    else if (r.type === 'input_cache_miss_tokens') e.cacheMiss += r.amount;
    e.cost += r.cost || 0;
  }
  return Array.from(map.values()).sort((a, b) => b.cost - a.cost);
}

function shortModel(m) {
  return String(m || 'unknown').replace(/^deepseek-/, '').replace(/-/g, ' ');
}

// 命中率颜色（保持现有色值体系：绿 #10B981 / 黄 #F59E0B / 橙 #F97316 / 红 #EF4444）
function hitRateColor(hit, miss) {
  const t = hit + miss;
  if (t === 0) return 'var(--muted)';
  const pct = (hit / t) * 100;
  if (pct >= 90) return '#10B981'; // 绿
  if (pct >= 70) return '#F59E0B'; // 黄
  if (pct >= 40) return '#F97316'; // 橙
  return '#EF4444';                 // 红
}

function hitRateOf(hit, miss) {
  const t = hit + miss;
  if (t === 0) return '-';
  return Math.round((hit / t) * 100) + '%';
}

// ---------------------------------------------------------------------------
// 渲染：总览
// ---------------------------------------------------------------------------
function renderOverview(filtered) {
  const days = aggregateByDay(filtered);
  let tokens = 0, cost = 0, requests = 0, cacheHit = 0, cacheMiss = 0;
  for (const r of filtered) {
    if (r.type === 'input_cache_hit_tokens') { tokens += r.amount; cacheHit += r.amount; }
    else if (r.type === 'input_cache_miss_tokens') { tokens += r.amount; cacheMiss += r.amount; }
    else if (r.type === 'output_tokens') tokens += r.amount;
    else if (r.type === 'request_count') requests += r.amount;
    cost += r.cost || 0;
  }
  els.totalTokens.textContent = fmt(tokens);
  els.totalCost.textContent = fmtMoney(cost);
  els.totalRequests.textContent = fmt(requests);
  els.cacheRate.textContent = fmtPct((cacheHit + cacheMiss) > 0 ? (cacheHit / (cacheHit + cacheMiss)) * 100 : 0);
  els.statActiveDays.textContent = `${days.filter((d) => d.tokens > 0 || d.requests > 0).length} 活跃天`;
}

// ---------------------------------------------------------------------------
// 渲染：趋势图
// ---------------------------------------------------------------------------
function renderTokenChart(days, gran) {
  const ctx = document.getElementById('chart-tokens');
  if (chartTokens) chartTokens.destroy();
  let labels, tokens, requests;
  if (gran === 'day') {
    labels = days.map((d) => d.date.slice(5));
    tokens = days.map((d) => d.tokens);
    requests = days.map((d) => d.requests);
  } else {
    // 按月聚合
    const mm = new Map();
    for (const d of days) {
      const m = d.date.slice(0, 7);
      if (!mm.has(m)) mm.set(m, { tokens: 0, requests: 0 });
      mm.get(m).tokens += d.tokens;
      mm.get(m).requests += d.requests;
    }
    const sorted = Array.from(mm.keys()).sort();
    labels = sorted;
    tokens = sorted.map((m) => mm.get(m).tokens);
    requests = sorted.map((m) => mm.get(m).requests);
  }
  chartTokens = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Token', data: tokens, borderColor: '#4f46e5', backgroundColor: 'rgba(79,70,229,0.08)', fill: true, tension: 0.3, pointRadius: gran === 'day' ? 1 : 3, yAxisID: 'y' },
        { label: '请求数', data: requests, borderColor: '#10b981', backgroundColor: 'transparent', borderDash: [4, 4], tension: 0.3, pointRadius: 0, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + fmt(c.raw) } },
      },
      scales: {
        y: { ticks: { callback: (v) => fmt(v) }, grid: { color: '#eef2ff' } },
        y1: { position: 'right', ticks: { callback: (v) => fmt(v) }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 渲染：模型饼图（用量 / 花费可切换，位置不变）
// ---------------------------------------------------------------------------
function renderModelPie(records) {
  const ctx = document.getElementById('chart-model');
  if (chartModel) chartModel.destroy();
  const map = new Map();
  for (const r of records) {
    if (pieMode === 'cost') {
      // 花费分布：累加每个模型的费用
      map.set(r.model, (map.get(r.model) || 0) + (r.cost || 0));
    } else {
      // 用量分布：只累计 token 行
      const isToken = r.type === 'input_cache_hit_tokens' || r.type === 'input_cache_miss_tokens' || r.type === 'output_tokens';
      if (!isToken) continue;
      map.set(r.model, (map.get(r.model) || 0) + r.amount);
    }
  }
  const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!entries.length) return;
  // 颜色与「模型每日 Token（堆叠）」的模型代表色保持一致
  const pieColors = entries.map((e) => modelSolidColor(e[0]));
  chartModel = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map((e) => shortModel(e[0])),
      datasets: [{ data: entries.map((e) => e[1]), backgroundColor: pieColors }],
    },
    options: {
      responsive: true, cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          enabled: false, // 统一使用自定义浅色 tooltip
          external: (context) => renderPieTip(context),
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 渲染：每日费用条形图
//   total 模式（默认）：每天一根柱 = 当日总费用，选中日高亮
//   model 模式：每天一根堆叠柱，柱内按模型分色（颜色与堆叠图/饼图一致），
//               各段代表该模型当天的花费
// 柱子可点击 → 选中该天 → 明细表联动
// ---------------------------------------------------------------------------
function renderDailyCost(days, records) {
  const ctx = document.getElementById('chart-cost');
  if (chartCost) chartCost.destroy();
  if (!days.length) return;
  const labels = days.map((d) => d.date);

  let datasets;
  let stacked = false;
  if (costMode === 'model') {
    // 按 (date, model) 聚合花费
    const per = new Map(); // date||model -> cost
    for (const r of records) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.utc_date)) continue;
      if (range.start && r.utc_date < range.start) continue;
      if (range.end && r.utc_date > range.end) continue;
      const k = r.utc_date + '||' + r.model;
      per.set(k, (per.get(k) || 0) + (r.cost || 0));
    }
    // 当天有费用的模型
    const modelsOnDays = new Map(); // date -> [model,...]（按花费降序）
    for (const [k, cost] of per) {
      const [date, model] = k.split('||');
      if (!modelsOnDays.has(date)) modelsOnDays.set(date, []);
      modelsOnDays.get(date).push({ model, cost });
    }
    // 全局模型集合（含当天所有出现过的模型），排序按代表色顺序
    const allModels = Array.from(new Set(Array.from(per.keys()).map((k) => k.split('||')[1])));
    // 取前 N+其他
    const modelTotals = new Map();
    for (const [k, cost] of per) {
      const model = k.split('||')[1];
      modelTotals.set(model, (modelTotals.get(model) || 0) + cost);
    }
    const topModels = Array.from(modelTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, MODEL_TOP_N).map((e) => e[0]);
    const isOther = (m) => !topModels.includes(m);
    const modelList = topModels.concat('__OTHER__');
    // 生成 per-date 的 "其他" 累计
    const otherByDate = new Map();
    for (const [k, cost] of per) {
      const [date, model] = k.split('||');
      if (!isOther(model)) continue;
      otherByDate.set(date, (otherByDate.get(date) || 0) + cost);
    }
    // 每模型一段
    datasets = [];
    modelList.forEach((m, i) => {
      const isOth = m === '__OTHER__';
      const label = isOth ? '其他' : shortModel(m);
      const color = isOth ? MODEL_PALETTE[MODEL_PALETTE.length - 1].output : modelSolidColor(m);
      const data = days.map((d) => {
        if (isOth) return otherByDate.get(d.date) || 0;
        return per.get(d.date + '||' + m) || 0;
      });
      datasets.push({ label, data, backgroundColor: color, stack: 'cost', borderRadius: 0 });
    });
    stacked = true;
  } else {
    const costs = days.map((d) => d.cost || 0);
    datasets = [{
      label: '费用',
      data: costs,
      backgroundColor: days.map((d) => (d.date === selectedDay ? '#4f46e5' : '#a5b4fc')),
      borderRadius: 3,
      borderSkipped: false,
    }];
  }

  chartCost = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      onClick: (evt, elems) => {
        if (elems && elems.length) {
          const idx = elems[0].index;
          const date = labels[idx];
          if (date) selectDay(date);
        }
      },
      plugins: {
        legend: costMode === 'model'
          ? { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } }
          : { display: false },
        tooltip: {
          enabled: false, // 统一使用自定义浅色 tooltip
          external: (context) => renderCostTip(context),
        },
      },
      scales: {
        x: { stacked, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, font: { size: 9 } } },
        y: { stacked, ticks: { callback: (v) => '¥' + fmt(v) }, grid: { color: '#eef2ff' } },
      },
    },
  });
  // 供"按模型"模式 tooltip 查询：date||model -> cost
  if (costMode === 'model') {
    chartCost.__per = new Map();
    for (const r of records) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.utc_date)) continue;
      const k = r.utc_date + '||' + r.model;
      chartCost.__per.set(k, (chartCost.__per.get(k) || 0) + (r.cost || 0));
    }
  }
}

// ---------------------------------------------------------------------------
// 渲染：模型每日 Token 堆叠柱状图（图二）
// X 轴 = 日期，每个模型一根堆叠柱，柱内三段（浅蓝=输入·缓存命中、
// 中蓝=输入·缓存未命中、深蓝=输出）。模型取用量前 N 个，其余归"其他"。
// 柱子可点击 → 选中该天 → 明细表联动
// ---------------------------------------------------------------------------
const MODEL_TOP_N = 5;

function renderModelDailyStacked(days, records) {
  const ctx = document.getElementById('chart-model-daily');
  if (chartModelDaily) chartModelDaily.destroy();
  if (!days.length) return;

  // 按 (date, model) 聚合三段
  const per = new Map(); // key = date||model
  const getCell = (date, model) => {
    const k = date + '||' + model;
    if (!per.has(k)) per.set(k, { date, model, hit: 0, miss: 0, output: 0 });
    return per.get(k);
  };
  const modelTotals = new Map();
  for (const r of records) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.utc_date)) continue;
    if (range.start && r.utc_date < range.start) continue;
    if (range.end && r.utc_date > range.end) continue;
    const c = getCell(r.utc_date, r.model);
    if (r.type === 'input_cache_hit_tokens') { c.hit += r.amount; modelTotals.set(r.model, (modelTotals.get(r.model) || 0) + r.amount); }
    else if (r.type === 'input_cache_miss_tokens') { c.miss += r.amount; modelTotals.set(r.model, (modelTotals.get(r.model) || 0) + r.amount); }
    else if (r.type === 'output_tokens') { c.output += r.amount; modelTotals.set(r.model, (modelTotals.get(r.model) || 0) + r.amount); }
  }
  if (!per.size) return;

  // 取用量前 N 个模型，其余归"其他"
  const topModels = Array.from(modelTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, MODEL_TOP_N).map((e) => e[0]);
  const isOther = (m) => !topModels.includes(m);
  const modelName = (m) => (isOther(m) ? '其他' : shortModel(m));
  const otherCell = new Map(); // date -> {hit,miss,output}

  const labels = days.map((d) => d.date);
  const build = (m) => {
    const hit = [], miss = [], output = [];
    for (const d of days) {
      let h = 0, ms = 0, o = 0;
      if (isOther(m)) {
        const oc = otherCell.get(d.date);
        if (oc) { h = oc.hit; ms = oc.miss; o = oc.output; }
      } else {
        const c = per.get(d.date + '||' + m);
        if (c) { h = c.hit; ms = c.miss; o = c.output; }
      }
      hit.push(h); miss.push(ms); output.push(o);
    }
    return { hit, miss, output };
  };
  // 先聚合"其他"
  for (const [k, c] of per) {
    const date = c.date;
    if (!isOther(c.model)) continue;
    if (!otherCell.has(date)) otherCell.set(date, { hit: 0, miss: 0, output: 0 });
    const oc = otherCell.get(date);
    oc.hit += c.hit; oc.miss += c.miss; oc.output += c.output;
  }

  const modelList = topModels.concat('__OTHER__');
  // 供自定义 tooltip 使用：date||stackLabel -> {hit, miss, output}
  const dayModel = new Map();
  const datasets = [];
  modelList.forEach((m, i) => {
    const isOth = m === '__OTHER__';
    const label = isOth ? '其他' : shortModel(m);
    const { hit, miss, output } = build(isOth ? '__OTHER__' : m);
    // 每个模型一个基础色调，三段用同一色系深浅：命中=浅、未命中=中、输出=深
    const col = modelColor(i, isOth, modelList.length);
    datasets.push(
      { label: label + ' · 输入·缓存命中', data: hit, backgroundColor: col.hit, stack: label, borderWidth: 0 },
      { label: label + ' · 输入·缓存未命中', data: miss, backgroundColor: col.miss, stack: label, borderWidth: 0 },
      { label: label + ' · 输出', data: output, backgroundColor: col.output, stack: label, borderWidth: 0 },
    );
    // 逐日填入 tooltip 查询表
    days.forEach((d, di) => {
      dayModel.set(d.date + '||' + label, { hit: hit[di], miss: miss[di], output: output[di] });
    });
  });

  chartModelDaily = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      onClick: (evt, elems) => {
        if (elems && elems.length) {
          const idx = elems[0].index;
          const date = labels[idx];
          if (date) selectDay(date);
        }
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 12, font: { size: 10 } },
        },
        tooltip: {
          enabled: false, // 自定义 tooltip
          external: (context) => renderStackTip(context),
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, font: { size: 9 } } },
        y: { stacked: true, ticks: { callback: (v) => fmt(v) }, grid: { color: '#eef2ff' } },
      },
    },
  });
  chartModelDaily.__dayModel = dayModel; // 供自定义 tooltip 查询
}

// ---------------------------------------------------------------------------
// 自定义 tooltip 通用助手（三个图表共用，风格统一、贴合柱子）
// caretX/caretY 相对 canvas 元素；用 fixed 定位到 body，坐标 =
// canvas 相对视口的偏移 + caretX/caretY，因此始终精确贴在柱子上方。
// ---------------------------------------------------------------------------
const TIP_ID = 'ds-tip';
const TIP_W = 220;

function getTip() {
  let tip = document.getElementById(TIP_ID);
  if (!tip) {
    tip = document.createElement('div');
    tip.id = TIP_ID;
    tip.className = 'ds-tip';
    document.body.appendChild(tip);
  }
  return tip;
}

function positionTip(tooltip, canvas) {
  const tip = getTip();
  const w = tip.offsetWidth || TIP_W;
  const h = tip.offsetHeight || 80;
  const rect = canvas.getBoundingClientRect();
  // canvas 相对视口的偏移 + chart 相对 canvas 的坐标
  const cx = rect.left + tooltip.caretX;
  const cy = rect.top + tooltip.caretY;
  let left = cx - w / 2; // 水平居中于柱子
  left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
  tip.style.left = left + 'px';
  tip.style.top = (cy - h - 8) + 'px'; // 贴合柱子上方
}

function hideTip() {
  const tip = document.getElementById(TIP_ID);
  if (tip) tip.style.opacity = 0;
}

function showTip(tooltip, html, canvas) {
  const tip = getTip();
  tip.innerHTML = html;
  tip.style.opacity = 1;
  positionTip(tooltip, canvas);
}

// 自定义 tooltip：鼠标移到某模型时，一框内显示 4 行
//   第1行：左侧=当天日期(xxxx-xx-xx)  右侧=该模型当天总 Token
//   第2行：输入（缓存命中） = 命中 Token
//   第3行：输入（缓存未命中） = 未命中 Token
//   第4行：输出 = 输出 Token
function renderStackTip(context) {
  const chart = context.chart;
  let tooltip = context.tooltip;
  if (!tooltip || tooltip.opacity === 0) { hideTip(); return; }
  const idx = tooltip.dataPoints[0].dataIndex;
  const date = chart.data.labels[idx];
  if (!date) { hideTip(); return; }

  // 命中线段 → 取对应堆叠模型名
  const dp = tooltip.dataPoints[0];
  const ds = chart.data.datasets[dp.datasetIndex];
  const modelLabel = ds.stack; // 该模型标签（"v4 pro" / "其他"）
  const dayModel = chart.__dayModel || new Map();
  const cell = dayModel.get(date + '||' + modelLabel) || { hit: 0, miss: 0, output: 0 };

  const hit = cell.hit || 0;
  const miss = cell.miss || 0;
  const output = cell.output || 0;
  const total = hit + miss + output;

  const html =
    '<div class="tip-row tip-head"><span>' + escapeHtml(date) + '</span><b>' + fmt(total) + '</b></div>' +
    '<div class="tip-row"><span>输入（缓存命中）</span><span class="tip-val">' + fmt(hit) + '</span></div>' +
    '<div class="tip-row"><span>输入（缓存未命中）</span><span class="tip-val">' + fmt(miss) + '</span></div>' +
    '<div class="tip-row"><span>输出</span><span class="tip-val">' + fmt(output) + '</span></div>';
  showTip(tooltip, html, chart.canvas);
}

// 饼图 tooltip：模型名 + 用量（或花费）+ 占比
function renderPieTip(context) {
  const tooltip = context.tooltip;
  if (!tooltip || tooltip.opacity === 0) { hideTip(); return; }
  const dp = tooltip.dataPoints[0];
  if (!dp) { hideTip(); return; }
  const chart = context.chart;
  const label = chart.data.labels[dp.dataIndex];
  const value = dp.raw;
  const dsData = dp.dataset && dp.dataset.data ? dp.dataset.data : chart.data.datasets[0].data;
  const total = dsData.reduce((s, v) => s + v, 0);
  const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
  const metric = pieMode === 'cost' ? fmtMoney(value) : fmt(value) + ' tokens';
  const html =
    '<div class="tip-row tip-head"><span>' + escapeHtml(label) + '</span><b>' + metric + '</b></div>' +
    '<div class="tip-row"><span>占比</span><span class="tip-val">' + pct + '%</span></div>';
  showTip(tooltip, html, chart.canvas);
}

// 每日费用图 tooltip：日期 + 当日总费用（或按模型模式下的该模型花费）
function renderCostTip(context) {
  const chart = context.chart;
  const tooltip = context.tooltip;
  if (!tooltip || tooltip.opacity === 0) { hideTip(); return; }
  const idx = tooltip.dataPoints[0].dataIndex;
  const date = chart.data.labels[idx];
  if (date === undefined) { hideTip(); return; }

  if (costMode === 'model') {
    // 悬停在某个模型的堆叠段上：显示该模型当天花费 + 当天总花费
    const dp = tooltip.dataPoints[0];
    const ds = chart.data.datasets[dp.datasetIndex];
    const modelLabel = ds.label;
    const value = ds.data[idx] || 0;
    // 当天总费用
    let dayTotal = 0;
    chart.data.datasets.forEach((d) => { dayTotal += d.data[idx] || 0; });
    const html =
      '<div class="tip-row tip-head"><span>' + escapeHtml(date) + '</span><b>' + fmtMoney(dayTotal) + '</b></div>' +
      '<div class="tip-row"><span>' + escapeHtml(modelLabel) + ' 花费</span><span class="tip-val">' + fmtMoney(value) + '</span></div>';
    showTip(tooltip, html, chart.canvas);
    return;
  }

  const value = chart.data.datasets[0].data[idx];
  const html =
    '<div class="tip-row tip-head"><span>' + escapeHtml(date) + '</span><b>' + fmtMoney(value) + '</b></div>';
  showTip(tooltip, html, chart.canvas);
}

// 给不同模型分配基础色：命中=浅、未命中=中、输出=深（同一色系三段）
// 用量第一的模型使用用户指定的参考蓝 #99D3FF / #5599FF / #3355EE
const MODEL_PALETTE = [
  { hit: '#99D3FF', miss: '#5599FF', output: '#3355EE' }, // 蓝（参考色，top1）
  { hit: '#A7F3D0', miss: '#34D399', output: '#059669' }, // 绿
  { hit: '#FDE68A', miss: '#FBBF24', output: '#D97706' }, // 橙
  { hit: '#DDD6FE', miss: '#A78BFA', output: '#7C3AED' }, // 紫
  { hit: '#FECACA', miss: '#F87171', output: '#DC2626' }, // 红
  { hit: '#CBD5E1', miss: '#94A3B8', output: '#475569' }, // 灰（"其他"）
];
// index 为模型在 modelList 中的位置：0=top1(蓝)，1=绿，2=橙…，最后一个="其他"(灰)
function modelColor(index, isOther) {
  if (isOther) return MODEL_PALETTE[MODEL_PALETTE.length - 1];
  return MODEL_PALETTE[index % (MODEL_PALETTE.length - 1)];
}

// ---- 统一的"模型 → 代表色"映射（饼图 / 每日费用按模型 / 堆叠图共用）----
// 模型代表色 = 该模型在堆叠图中的"输出"色（深色），由当前范围内 token 用量排序决定。
// 在 renderAll 开头调用 computeModelSolidMap 预计算，三个模块渲染顺序无关。
let modelSolidMap = new Map(); // model 全名 -> 代表色（hex）

function modelSolidColor(model) {
  return modelSolidMap.get(model) || MODEL_PALETTE[MODEL_PALETTE.length - 1].output; // 默认灰
}

// 依据当前范围 records 计算模型代表色：按 token 用量排序，top1=蓝 top2=绿…，其余灰
function computeModelSolidMap(records) {
  const totals = new Map();
  for (const r of records) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.utc_date)) continue; // 与堆叠图一致：只统计有日期的行
    const isToken = r.type === 'input_cache_hit_tokens' || r.type === 'input_cache_miss_tokens' || r.type === 'output_tokens';
    if (!isToken) continue;
    totals.set(r.model, (totals.get(r.model) || 0) + r.amount);
  }
  const top = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).slice(0, MODEL_TOP_N);
  const topSet = new Set(top.map((e) => e[0]));
  modelSolidMap = new Map();
  top.forEach(([m], i) => {
    modelSolidMap.set(m, MODEL_PALETTE[i % (MODEL_PALETTE.length - 1)].output);
  });
  for (const m of totals.keys()) {
    if (!topSet.has(m)) modelSolidMap.set(m, MODEL_PALETTE[MODEL_PALETTE.length - 1].output);
  }
}

// ---------------------------------------------------------------------------
// 渲染：热力图（GitHub 风格，按天费用深浅，可点击）
// ---------------------------------------------------------------------------
function renderHeatmap(days) {
  els.heatmap.innerHTML = '';
  if (!days.length) return;
  const byMonth = {};
  for (const d of days) {
    const m = d.date.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(d);
  }
  const maxCost = Math.max(...days.map((d) => d.cost || 0), 1);
  const weekday = (ymd) => new Date(ymd + 'T00:00:00').getDay();

  for (const m of Object.keys(byMonth).sort()) {
    const entries = byMonth[m];
    const map = {};
    for (const e of entries) map[e.date.slice(8)] = e;

    const wrap = document.createElement('div');
    wrap.className = 'hm-month';
    const title = document.createElement('div');
    title.className = 'hm-month-title';
    title.textContent = m;
    wrap.appendChild(title);

    const firstDow = weekday(entries[0].date);
    const lastDay = Number(entries[entries.length - 1].date.slice(8));
    const row = document.createElement('div');
    row.className = 'hm-row';
    for (let i = 0; i < firstDow; i++) {
      const blank = document.createElement('span');
      blank.className = 'hm-cell';
      blank.style.background = 'transparent';
      blank.style.cursor = 'default';
      row.appendChild(blank);
    }
    for (let day = 1; day <= lastDay; day++) {
      const dd = String(day).padStart(2, '0');
      const cell = document.createElement('span');
      cell.className = 'hm-cell';
      const e = map[dd];
      const ymd = m + '-' + dd;
      if (e && (e.cost || 0) > 0) {
        const t = Math.min((e.cost || 0) / maxCost, 1);
        const r = Math.round(238 + (79 - 238) * t);
        const g = Math.round(242 + (70 - 242) * t);
        const b = Math.round(255 + (229 - 255) * t);
        cell.style.background = `rgb(${r},${g},${b})`;
        cell.title = `${ymd} · 花费 ${fmtMoney(e.cost || 0)} · ${fmt(e.tokens)} tokens`;
      }
      cell.dataset.date = ymd;
      if (selectedDay === ymd) cell.classList.add('selected');
      cell.addEventListener('click', () => {
        selectDay(ymd);
      });
      row.appendChild(cell);
    }
    wrap.appendChild(row);
    els.heatmap.appendChild(wrap);
  }
}

// 选中某一天 → 刷新明细表 + 高亮热力图
function selectDay(dateStr) {
  selectedDay = dateStr;
  // 高亮
  document.querySelectorAll('.hm-cell.selected').forEach((el) => el.classList.remove('selected'));
  const sel = document.querySelector(`.hm-cell[data-date="${dateStr}"]`);
  if (sel) sel.classList.add('selected');
  renderDayDetail(dateStr);
}

// ---------------------------------------------------------------------------
// 渲染：每日明细表（仿官方 detail-table）
// ---------------------------------------------------------------------------
function renderDayDetail(dateStr) {
  if (!dateStr) {
    els.detailTitle.innerHTML = '📋 每日明细 — 点击热力图中的某天';
    els.detailBody.innerHTML = `
      <div class="detail-empty">
        <div class="empty-graphic">📅</div>
        <div class="empty-title">选择一个日期查看该天各模型的用量</div>
        <div class="empty-hint">点击上方热力图格子，或使用日期选择器</div>
      </div>`;
    return;
  }
  const entries = aggregateDayEntries(allRecords, dateStr, detailGran);
  const dayTotal = entries.reduce((s, e) => s + e.cost, 0);
  els.detailTitle.innerHTML = `${escapeHtml(fmtDateCn(dateStr))} <span class="day-cost-badge">${fmtMoney(dayTotal)}</span>`;

  if (!entries.length) {
    els.detailBody.innerHTML = `<div class="detail-empty"><div class="empty-title">当天无用量数据</div></div>`;
    return;
  }

  let totalOut = 0, totalHit = 0, totalMiss = 0;
  let html = '<table class="detail-table"><thead><tr>' +
    '<th>' + (detailGran === 'key' ? 'API Key' : '模型') + '</th>' +
    '<th class="num">输出 Token</th><th class="num">缓存命中</th><th class="num">缓存未命中</th>' +
    '<th class="num">命中率</th><th class="num">花费</th></tr></thead><tbody>';

  for (const e of entries) {
    totalOut += e.output; totalHit += e.cacheHit; totalMiss += e.cacheMiss;
    html += '<tr>' +
      '<td><span class="model-cell">' + escapeHtml(e.label.main) + (e.label.sub ? '<small>' + escapeHtml(e.label.sub) + '</small>' : '') + '</span></td>' +
      '<td class="num">' + fmt(e.output) + '</td>' +
      '<td class="num">' + fmt(e.cacheHit) + '</td>' +
      '<td class="num">' + fmt(e.cacheMiss) + '</td>' +
      '<td class="num" style="font-weight:600;color:' + hitRateColor(e.cacheHit, e.cacheMiss) + ';">' + hitRateOf(e.cacheHit, e.cacheMiss) + '</td>' +
      '<td class="cost-cell">' + fmtMoney(e.cost) + '</td>' +
      '</tr>';
  }
  html += '<tr class="total-row">' +
    '<td><span class="model-cell">Total<small>' + entries.length + ' 项</small></span></td>' +
    '<td class="num">' + fmt(totalOut) + '</td>' +
    '<td class="num">' + fmt(totalHit) + '</td>' +
    '<td class="num">' + fmt(totalMiss) + '</td>' +
    '<td class="num" style="font-weight:600;color:' + hitRateColor(totalHit, totalMiss) + ';">' + hitRateOf(totalHit, totalMiss) + '</td>' +
    '<td class="cost-cell">' + fmtMoney(dayTotal) + '</td>' +
    '</tr></tbody></table>';
  els.detailBody.innerHTML = html;
}

// ---------------------------------------------------------------------------
// 渲染：API Key 汇总表
// ---------------------------------------------------------------------------
function renderApiKeyTable(records) {
  els.apiKeyTable.innerHTML = '';
  const map = new Map();
  for (const r of records) {
    const k = r.api_key_name || 'default';
    if (!map.has(k)) map.set(k, { input: 0, output: 0, cost: 0, requests: 0 });
    const s = map.get(k);
    if (r.type === 'input_cache_hit_tokens' || r.type === 'input_cache_miss_tokens') s.input += r.amount;
    else if (r.type === 'output_tokens') s.output += r.amount;
    else if (r.type === 'request_count') s.requests += r.amount;
    s.cost += r.cost || 0;
  }
  const sorted = Array.from(map.entries()).sort((a, b) => b[1].cost - a[1].cost);
  for (const [name, s] of sorted) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(name)}</td><td class="num">${fmt(s.input)}</td><td class="num">${fmt(s.output)}</td><td class="num">${fmtMoney(s.cost)}</td><td class="num">${fmt(s.requests)}</td>`;
    els.apiKeyTable.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// 主渲染入口
// ---------------------------------------------------------------------------
function renderAll() {
  const filtered = filterByRange(allRecords);
  computeModelSolidMap(filtered); // 先统一计算模型代表色，三个图表颜色一致
  renderOverview(filtered);
  const days = aggregateByDay(filtered);
  const gran = document.querySelector('#trend-seg button.active').dataset.gran;
  renderTokenChart(days, gran);
  renderModelPie(filtered);
  renderDailyCost(days, filtered);
  renderModelDailyStacked(days, filtered);
  renderHeatmap(days);
  renderApiKeyTable(filtered);
  renderDayDetail(selectedDay);
}

// ---------------------------------------------------------------------------
// 日期范围
// ---------------------------------------------------------------------------
function applyPreset(kind) {
  const today = new Date();
  if (kind === 'all') { range = { start: null, end: null }; }
  else if (kind === '12m') { range = { start: toYMD(addDays(today, -365)), end: toYMD(today) }; }
  else if (kind === '30d') { range = { start: toYMD(addDays(today, -29)), end: toYMD(today) }; }
  else if (kind === '7d') { range = { start: toYMD(addDays(today, -6)), end: toYMD(today) }; }
  else if (kind === 'month') {
    range = { start: toYMD(new Date(today.getFullYear(), today.getMonth(), 1)), end: toYMD(today) };
  }
  document.querySelectorAll('#range-bar .range-presets button').forEach((b) => {
    b.classList.toggle('active', b.dataset.range === kind);
  });
  els.dateStart.value = range.start || '';
  els.dateEnd.value = range.end || '';
  renderAll();
}

els.rangePresets.forEach((btn) => {
  btn.addEventListener('click', () => applyPreset(btn.dataset.range));
});
els.btnApplyRange.addEventListener('click', () => {
  const s = els.dateStart.value || null;
  const e = els.dateEnd.value || null;
  if (s && e && s > e) {
    els.syncStatus.textContent = '⚠️ 起始日期不能晚于结束日期';
    return;
  }
  range = { start: s, end: e };
  document.querySelectorAll('#range-bar .range-presets button').forEach((b) => b.classList.remove('active'));
  renderAll();
});

// ---------------------------------------------------------------------------
// 分段切换（趋势图 + 明细粒度）
// ---------------------------------------------------------------------------
els.trendSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#trend-seg button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  renderAll();
});
els.detailSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#detail-seg button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  detailGran = btn.dataset.gran;
  renderDayDetail(selectedDay);
});
els.modelSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#model-seg button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  pieMode = btn.dataset.gran;
  els.modelTitle.textContent = pieMode === 'cost' ? '🥧 模型花费分布' : '🥧 模型用量分布';
  renderModelPie(filterByRange(allRecords));
});
els.costSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#cost-seg button').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  costMode = btn.dataset.gran;
  const filtered = filterByRange(allRecords);
  renderDailyCost(aggregateByDay(filtered), filtered);
});

// ---------------------------------------------------------------------------
// 自动同步：打开弹窗时静默同步当月（不打扰用户）
// ---------------------------------------------------------------------------
async function autoSyncCurrentMonth() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const dsTab = tabs.find((t) => t.url && t.url.includes('platform.deepseek.com'));
    if (!dsTab) return; // 没有 DeepSeek 页面就不自动同步
    // 只在有 DeepSeek 标签页时尝试（此时有登录态）
    const ready = await ensureContentScript(dsTab.id);
    if (!ready) return;
    const now = new Date();
    const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const res = await chrome.tabs.sendMessage(dsTab.id, { action: 'syncMonth', month: cur });
    if (res && res.ok && (res.added > 0 || res.updated > 0)) {
      // 有更新则刷新视图（静默，不改状态栏）
      await refreshData();
    }
  } catch (e) { /* 静默失败，不影响使用 */ }
}

// ---------------------------------------------------------------------------
// 数据刷新
// ---------------------------------------------------------------------------
async function refreshData() {
  allRecords = await loadAllRecords();
  renderAll();
  try {
    const meta = await chrome.runtime.sendMessage({ action: 'getMeta', key: 'last_sync' });
    if (meta && meta.ok && meta.value && meta.value.at) {
      const dt = new Date(meta.value.at);
      els.lastSync.textContent = '上次同步：' + dt.toLocaleString('zh-CN', { hour12: false });
    }
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 同步
// ---------------------------------------------------------------------------

/**
 * 确保目标标签页已注入 content script（用户可能在加载插件之前就打开了
 * DeepSeek 页面，此时 content script 尚未注入，直接 sendMessage 会抛
 * "Receiving end does not exist"）。
 */
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['lib/csv.js', 'lib/fflate.umd.js', 'content.js'],
      });
      return true;
    } catch (e2) {
      console.warn('[DeepSeek 用量全史] 注入 content script 失败:', e2);
      return null;
    }
  }
}

els.btnSync.addEventListener('click', async () => {
  els.btnSync.disabled = true;
  els.btnSync.textContent = '⏳ 同步中…';
  els.syncStatus.textContent = '正在查找 DeepSeek 页面…';

  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const dsTab = tabs.find((t) => t.url && t.url.includes('platform.deepseek.com'));
    if (!dsTab) {
      els.syncStatus.textContent = '⚠️ 请先打开并登录 platform.deepseek.com';
      return;
    }
    const ready = await ensureContentScript(dsTab.id);
    if (!ready) {
      els.syncStatus.textContent = '⚠️ 注入失败，请刷新 DeepSeek 页面后重试';
      return;
    }
    const result = await chrome.tabs.sendMessage(dsTab.id, { action: 'sync' });
    if (!result) {
      els.syncStatus.textContent = '⚠️ 页面未响应，请刷新 DeepSeek 页面后重试';
    } else if (result.error === 'no_token') {
      els.syncStatus.textContent = '⚠️ 未找到登录凭证，请先在 DeepSeek 后台登录';
    } else if (result.authFailed) {
      els.syncStatus.textContent = '⚠️ 认证失败，请刷新页面重新登录后重试';
    } else {
      els.syncStatus.textContent =
        `✅ 完成：新增 ${result.totalAdded}、更新 ${result.totalUpdated} 条（${result.months} 个月，${result.elapsed}s）`;
    }
    await refreshData(); // 保留状态栏，刷新数据
  } catch (err) {
    els.syncStatus.textContent = '⚠️ ' + (err && err.message || '同步失败');
  } finally {
    els.btnSync.disabled = false;
    els.btnSync.textContent = '🔄 同步全部历史';
  }
});

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------
els.btnDiagnose.addEventListener('click', async () => {
  els.syncStatus.textContent = '正在诊断…';
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const dsTab = tabs.find((t) => t.url && t.url.includes('platform.deepseek.com'));
    if (!dsTab) {
      els.syncStatus.textContent = '⚠️ 未找到 platform.deepseek.com 标签页';
      return;
    }
    const ready = await ensureContentScript(dsTab.id);
    if (!ready) {
      els.syncStatus.textContent = '⚠️ 注入失败，请刷新 DeepSeek 页面后重试';
      return;
    }
    const d = await chrome.tabs.sendMessage(dsTab.id, { action: 'diagnose' });
    const lines = [
      `页面: ${d.onPage ? '✅' : '❌'} ${d.onPage ? 'platform.deepseek.com' : '不是 DeepSeek 页面'}`,
      `登录凭证: ${d.loggedIn ? '✅ ' + d.tokenFound : '❌ 未找到'}`,
    ];
    if (d.localKeys && d.localKeys.length) lines.push(`localStorage 疑似 token 的 key: ${d.localKeys.join(', ')}`);
    if (d.cookieNames && d.cookieNames.length) lines.push(`cookies: ${d.cookieNames.join(', ')}`);
    if (d.exportCheck) {
      const e = d.exportCheck;
      lines.push(`导出接口: HTTP ${e.status} / ${e.bytes} 字节 / ${e.isZip ? 'ZIP' : '非ZIP'} — ${e.note || ''}`);
    }
    if (d.summaryCheck) {
      lines.push(`账户接口: HTTP ${d.summaryCheck.status} — ${(d.summaryCheck.body || '').slice(0, 60)}`);
    }
    if (d.error) lines.push('诊断错误: ' + d.error);
    els.syncStatus.textContent = lines.join('\n');
  } catch (err) {
    els.syncStatus.textContent = '⚠️ 诊断失败：' + (err && err.message || err);
  }
});

// ---------------------------------------------------------------------------
// 导出 CSV（当前范围全部明细，长表）
// ---------------------------------------------------------------------------
els.btnExport.addEventListener('click', async () => {
  try {
    const filtered = filterByRange(allRecords);
    if (!filtered.length) {
      els.syncStatus.textContent = '暂无数据可导出';
      return;
    }
    const header = 'month,utc_date,model,api_key_name,type,amount,price,cost';
    const lines = filtered.map((r) =>
      [r.month, r.utc_date, r.model, r.api_key_name, r.type, r.amount, r.price, r.cost]
        .map((v) => { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; })
        .join(',')
    );
    const csv = [header].concat(lines).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deepseek-usage-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    els.syncStatus.textContent = `已导出 ${filtered.length} 条记录`;
  } catch (err) {
    els.syncStatus.textContent = '导出失败：' + (err.message || err);
  }
});

// ---------------------------------------------------------------------------
// 清除
// ---------------------------------------------------------------------------
els.btnClear.addEventListener('click', async () => {
  if (!confirm('确定清除所有本地用量历史吗？此操作不可恢复。')) return;
  await chrome.runtime.sendMessage({ action: 'clearAll' });
  els.syncStatus.textContent = '已清除本地数据';
  await refreshData();
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  applyPreset('all'); // 默认全部历史
  await refreshData();
  // 静默自动同步当月（若打开了 DeepSeek 页面）
  setTimeout(autoSyncCurrentMonth, 800);
});
