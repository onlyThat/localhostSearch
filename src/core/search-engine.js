'use strict';

/**
 * 内存搜索引擎。
 * 索引条目在 Python 侧预生成了三种检索键：
 *   n  -> 原始文件名
 *   a  -> 拼音/字母首字母（wx -> 微信）
 *   f  -> 全拼（weixin -> 微信）
 *   x  -> 首字母各位对应的原始字符下标（用于精确高亮）
 */

const BOUNDARY = /[\s_\-.()\[\]{}]/;

function isBoundary(ch) {
  return !ch || BOUNDARY.test(ch);
}

/** 子序列模糊匹配，返回得分与命中位置。 */
function subsequence(text, query) {
  if (!query) return null;
  const positions = [];
  let cursor = 0;
  let score = 0;
  for (const q of query) {
    const at = text.indexOf(q, cursor);
    if (at === -1) return null;
    if (positions.length) {
      const gap = at - positions[positions.length - 1] - 1;
      score -= Math.min(gap, 8);
      if (gap === 0) score += 10;
    }
    if (at === 0 || isBoundary(text[at - 1])) score += 12;
    positions.push(at);
    cursor = at + 1;
  }
  return { score, positions };
}

/** 在多个候选中取分数最高的匹配方式。 */
function better(current, candidate) {
  return candidate && candidate.score > current.score ? candidate : current;
}

class SearchEngine {
  constructor() {
    this.items = [];
    this.meta = null;
  }

  load(entries, meta) {
    this.meta = meta || null;
    this.items = entries.map((e) => ({
      path: e.p || '',
      name: e.n || '',
      lower: (e.n || '').toLowerCase(),
      pathLower: (e.p || '').toLowerCase(),
      initials: (e.a || '').toLowerCase(),
      full: (e.f || '').toLowerCase(),
      map: e.x ? e.x.split(',').map(Number) : null,
      isDir: !!e.d,
      size: e.s || 0,
      mtime: e.m || 0,
    }));
    return this.items.length;
  }

  clear() {
    this.items = [];
    this.meta = null;
  }

  get size() {
    return this.items.length;
  }

  /** 单个词对单条记录的最佳匹配。 */
  _scoreToken(item, token) {
    const best = { score: 0, kind: '', pos: -1, positions: null };
    const { lower, initials, full, pathLower } = item;

    if (lower === token) {
      best.score = 1000;
      best.kind = 'name';
      best.pos = 0;
    } else if (lower.startsWith(token)) {
      best.score = 800;
      best.kind = 'name';
      best.pos = 0;
    } else {
      const at = lower.indexOf(token);
      if (at >= 0) {
        best.score = 560 - Math.min(at, 40) * 3;
        best.kind = 'name';
        best.pos = at;
      }
    }

    // 拼音首字母：wx -> 微信
    if (initials) {
      if (initials === token) {
        Object.assign(best, better(best, { score: 920, kind: 'initials', pos: 0 }));
      } else if (initials.startsWith(token)) {
        Object.assign(best, better(best, { score: 760, kind: 'initials', pos: 0 }));
      } else {
        const at = initials.indexOf(token);
        if (at >= 0) {
          Object.assign(best, better(best, {
            score: 500 - Math.min(at, 40) * 3, kind: 'initials', pos: at,
          }));
        }
      }
    }

    // 全拼：weixin -> 微信
    if (full) {
      if (full === token) {
        Object.assign(best, better(best, { score: 880, kind: 'full', pos: 0 }));
      } else if (full.startsWith(token)) {
        Object.assign(best, better(best, { score: 700, kind: 'full', pos: 0 }));
      } else {
        const at = full.indexOf(token);
        if (at >= 0) {
          Object.assign(best, better(best, {
            score: 460 - Math.min(at, 40) * 3, kind: 'full', pos: at,
          }));
        }
      }
    }

    // 名称内模糊子序列：wlc -> "WeChat Local Cache"
    if (token.length >= 2 && token.length <= lower.length) {
      const fz = subsequence(lower, token);
      if (fz) {
        Object.assign(best, better(best, {
          score: 240 + fz.score, kind: 'fuzzy', positions: fz.positions,
        }));
      }
    }

    // 目录路径兜底
    const pathAt = pathLower.indexOf(token);
    if (pathAt >= 0) {
      Object.assign(best, better(best, {
        score: 90 - Math.min(pathAt, 40), kind: 'path', pos: pathAt,
      }));
    }
    return best;
  }

  /** 把命中位置转成文件名上的高亮区间。 */
  _highlights(item, match, token) {
    if (match.kind === 'name') {
      return [{ start: match.pos, end: match.pos + token.length }];
    }
    if (match.kind === 'fuzzy' && match.positions) {
      return match.positions.map((i) => ({ start: i, end: i + 1 }));
    }
    if (match.kind === 'initials' && item.map) {
      const indices = item.map.slice(match.pos, match.pos + token.length);
      return indices.filter((i) => Number.isInteger(i)).map((i) => ({ start: i, end: i + 1 }));
    }
    return [];
  }

  /**
   * 搜索。支持空格分词，多个词之间是 AND 关系。
   * @returns {Array<{item, score, highlights, types, pathHighlight}>}
   */
  search(query, options = {}) {
    const limit = options.limit || 200;
    const type = options.type || 'all';
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    const top = [];
    const minScore = 0; // 每个词都必须真正命中，不能只靠长度加分混入结果

    for (const item of this.items) {
      if (type === 'file' && item.isDir) continue;
      if (type === 'dir' && !item.isDir) continue;
      let total = 0;
      const highlights = [];
      const types = [];
      let pathHighlight = -1;
      let ok = true;
      for (const token of tokens) {
        const m = this._scoreToken(item, token);
        if (m.score <= minScore) {
          ok = false;
          break;
        }
        total += m.score;
        types.push(m.kind);
        if (m.kind === 'path') {
          pathHighlight = m.pos;
        } else {
          highlights.push(...this._highlights(item, m, token));
        }
      }
      if (!ok) continue;

      // 所有词都命中文件名类字段时给一点加权
      if (types.every((t) => t === 'name' || t === 'initials' || t === 'full' || t === 'fuzzy')) {
        total += 40;
      }
      // 同分时短名称优先，且文件夹略微靠前
      total += Math.max(0, 30 - item.name.length) * 0.2;
      if (item.isDir) total += 6;

      const entry = { item, score: total, highlights, types, pathHighlight };
      // 有界插入，避免每次按键都排序十万条结果
      if (top.length < limit) {
        let lo = 0;
        let hi = top.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (top[mid].score >= total) lo = mid + 1;
          else hi = mid;
        }
        top.splice(lo, 0, entry);
      } else if (total > top[top.length - 1].score) {
        let lo = 0;
        let hi = top.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (top[mid].score >= total) lo = mid + 1;
          else hi = mid;
        }
        if (total > top[lo].score) {
          top.splice(lo, 0, entry);
          top.pop();
        }
      }
    }
    return top;
  }
}

module.exports = { SearchEngine, subsequence };
