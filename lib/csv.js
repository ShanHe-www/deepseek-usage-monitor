/**
 * lib/csv.js — DeepSeek 用量导出 CSV 的解析与聚合（零依赖，UMD）。
 *
 * DeepSeek 后台导出的 amount-*.csv 是"长表"格式，每行表示某个维度下
 * 一种指标的累计值，列大致为：
 *
 *   utc_date, model, api_key_name, type, price, amount
 *
 * 其中 type ∈ { input_cache_hit_tokens, input_cache_miss_tokens,
 *                output_tokens, request_count }
 * 注意：utc_date 可能是 "YYYY-MM-DD"（早期）或 "YYYYMMDD"（新版），
 * 也可能整月只有一行 TOTAL（date 为 "TOTAL" 或空）。
 *
 * 本文件同时导出：
 *   parseDeepSeekCSV(text)   -> rows（原始行，规范化 utc_date）
 *   aggregate(rows)          -> { months:[], days:[], records:[] }
 *
 * 在浏览器中以全局对象 DsCSV 暴露，在 Node 中以 module.exports 暴露，
 * 这样 content.js / popup / Node 测试都能复用同一份解析逻辑。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.DsCSV = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- CSV 行解析（处理引号包裹字段）--------------------------------------
  function parseCSVLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          out.push(cur);
          cur = '';
        } else {
          cur += ch;
        }
      }
    }
    out.push(cur);
    return out;
  }

  /**
   * 解析 DeepSeek amount CSV 文本 → 规范化原始行数组。
   * 每一行：{ utc_date, model, api_key_name, type, price, amount, _row }
   * utc_date 统一为 "YYYY-MM-DD"（TOTAL 行为 "TOTAL"，缺失为 ""）。
   */
  function parseDeepSeekCSV(text) {
    if (!text) return [];
    // 去掉 BOM，统一换行
    let body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const lines = body.split('\n');
    const first = lines.findIndex((l) => l.trim().length > 0);
    if (first === -1) return [];
    const headerLine = lines[first].trim();
    const headers = parseCSVLine(headerLine).map((h) => h.trim());
    const col = (names) => {
      for (const n of names) {
        const i = headers.findIndex((h) => h.toLowerCase() === n.toLowerCase());
        if (i !== -1) return i;
      }
      return -1;
    };
    const idx = {
      utc_date: col(['utc_date', 'date', '日期', 'day']),
      model: col(['model', '模型', 'model_name']),
      api_key_name: col(['api_key_name', 'api_key', 'key_name', 'api_key_id', 'key']),
      type: col(['type', '类型', 'metric', 'metric_name']),
      price: col(['price', '单价', 'unit_price']),
      amount: col(['amount', '用量', 'value', 'count']),
    };
    const rows = [];
    for (let i = first + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const v = parseCSVLine(line);
      const row = {};
      headers.forEach((h, j) => {
        row[h] = j < v.length ? v[j].trim() : '';
      });
      let rawDate = row.utc_date || '';
      rawDate = rawDate.trim();
      // 新版可能是 YYYYMMDD
      if (/^\d{8}$/.test(rawDate)) {
        rawDate = rawDate.slice(0, 4) + '-' + rawDate.slice(4, 6) + '-' + rawDate.slice(6, 8);
      }
      const type = (row.type || '').trim();
      const amount = parseFloat(row.amount);
      rows.push({
        utc_date: rawDate,
        model: (row.model || '').trim() || 'unknown',
        api_key_name: (row.api_key_name || '').trim() || 'default',
        type: type,
        price: parseFloat(row.price) || 0,
        amount: isNaN(amount) ? 0 : amount,
        _row: i,
      });
      void idx;
    }
    return rows;
  }

  const TYPE_GROUPS = {
    input_cache_hit_tokens: 'input_cache_hit_tokens',
    input_cache_miss_tokens: 'input_cache_miss_tokens',
    output_tokens: 'output_tokens',
    request_count: 'request_count',
  };
  // 其它可能的 type 别名
  const TYPE_ALIASES = {
    prompt_cache_hit_tokens: 'input_cache_hit_tokens',
    prompt_cache_miss_tokens: 'input_cache_miss_tokens',
    completion_tokens: 'output_tokens',
    requests: 'request_count',
    request: 'request_count',
    response_tokens: 'output_tokens',
  };

  function normType(t) {
    if (!t) return null;
    const lower = t.toLowerCase();
    if (TYPE_GROUPS[lower]) return lower;
    if (TYPE_ALIASES[lower]) return TYPE_ALIASES[lower];
    return null;
  }

  /**
   * 聚合：把解析后的原始行聚合成三类数据。
   *  - months: 按月聚合 [{ month:"YYYY-MM", tokens, input, output, cost, requests }]
   *  - days:   按天聚合 [{ date:"YYYY-MM-DD", tokens, input, output, cost, requests }]（TOTAL 行不计入天）
   *  - records: 完整明细（用于 API Key 维度、模型分布、导出）
   */
  function aggregate(rows) {
    // 明细记录
    const records = rows
      .filter((r) => r.type !== undefined && r.type !== null)
      .map((r) => {
        const t = normType(r.type);
        // 费用 = 单价 × 用量（仅当 CSV 提供了单价时；request_count 行通常无单价）
        const cost = r.price && isFinite(r.price) && r.price > 0 ? r.amount * r.price : 0;
        return {
          month: r.month || (r.utc_date && /^\d{4}-\d{2}-\d{2}$/.test(r.utc_date) ? r.utc_date.slice(0, 7) : ''),
          utc_date: r.utc_date,
          model: r.model,
          api_key_name: r.api_key_name,
          type: r.type,
          normType: t,
          amount: r.amount,
          price: r.price,
          cost: cost,
        };
      });

    const monthMap = new Map();
    const dayMap = new Map();

    const ensureMonth = (m) => {
      if (!monthMap.has(m)) {
        monthMap.set(m, { month: m, tokens: 0, input: 0, output: 0, cost: 0, requests: 0 });
      }
      return monthMap.get(m);
    };
    const ensureDay = (d) => {
      if (!dayMap.has(d)) {
        dayMap.set(d, { date: d, tokens: 0, input: 0, output: 0, cost: 0, requests: 0 });
      }
      return dayMap.get(d);
    };

    for (const r of records) {
      const isToken = r.normType === 'input_cache_hit_tokens' ||
        r.normType === 'input_cache_miss_tokens' ||
        r.normType === 'output_tokens';
      const isRequest = r.normType === 'request_count';

      // TOTAL 行（JSON 兜底）没有具体日期，需用显式 month 归入对应月份
      const month = r.month || (r.utc_date && /^\d{4}-\d{2}-\d{2}$/.test(r.utc_date) ? r.utc_date.slice(0, 7) : '');
      if (month) {
        const m = ensureMonth(month);
        if (isToken) {
          m.tokens += r.amount;
          m.input += (r.normType === 'output_tokens') ? 0 : r.amount;
          m.output += (r.normType === 'output_tokens') ? r.amount : 0;
        } else if (isRequest) {
          m.requests += r.amount;
        }
        if (r.cost) m.cost += r.cost;
      }

      // 只有带真实日期（YYYY-MM-DD）的行才进入按天聚合
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.utc_date)) {
        const d = ensureDay(r.utc_date);
        if (isToken) {
          d.tokens += r.amount;
          d.input += (r.normType === 'output_tokens') ? 0 : r.amount;
          d.output += (r.normType === 'output_tokens') ? r.amount : 0;
        } else if (isRequest) {
          d.requests += r.amount;
        }
        if (r.cost) d.cost += r.cost;
      }
    }

    const months = Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month));
    const days = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    return { months, days, records };
  }

  return {
    parseCSVLine: parseCSVLine,
    parseDeepSeekCSV: parseDeepSeekCSV,
    aggregate: aggregate,
    normType: normType,
  };
});
