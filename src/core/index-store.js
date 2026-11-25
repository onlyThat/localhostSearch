'use strict';

const fs = require('fs/promises');
const path = require('path');

/** 索引文件是 JSONL：前面是条目，最后一行带 _meta 标记。 */
class IndexStore {
  constructor(indexPath) {
    this.indexPath = indexPath;
  }

  async exists() {
    try {
      await fs.access(this.indexPath);
      return true;
    } catch {
      return false;
    }
  }

  async load() {
    const text = await fs.readFile(this.indexPath, 'utf8');
    const entries = [];
    let meta = null;
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj._meta) meta = obj;
        else entries.push(obj);
      } catch {
        // 单行损坏不影响整个索引
      }
    }
    return { entries, meta };
  }

  async remove() {
    try {
      await fs.unlink(this.indexPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

module.exports = { IndexStore, readJson, writeJson };
