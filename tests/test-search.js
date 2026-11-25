'use strict';

const assert = require('assert');
const path = require('path');
const { SearchEngine } = require('../src/core/search-engine');

const entries = [
  { p: 'D:\\Work\\微信聊天记录.xlsx', n: '微信聊天记录.xlsx', d: 0, s: 2048, m: 1700000000, a: 'wxltjlxlsx', f: 'weixinliaotianjiluxlsx', x: '0,1,2,3,4,5,7,8,9,10' },
  { p: 'D:\\Work\\微信.pcblib', n: '微信.pcblib', d: 0, s: 100, m: 1600000000, a: 'wxpcblib', f: 'weixinpcblib', x: '0,1,3,4,5,6,7,8' },
  { p: 'D:\\Work\\项目资料', n: '项目资料', d: 1, s: 0, m: 1500000000, a: 'xmzl', f: 'xiangmuziliao', x: '0,1,2,3' },
  { p: 'D:\\Other\\WeChat Setup.exe', n: 'WeChat Setup.exe', d: 0, s: 99999, m: 1800000000, a: 'wxs.exe', f: 'wxs.exe' },
  { p: 'D:\\Other\\notes.txt', n: 'notes.txt', d: 0, s: 12, m: 1400000000, a: 'notestxt', f: 'notestxt' },
];

const engine = new SearchEngine();
engine.load(entries, { mode: 'walk', count: entries.length });
assert.strictEqual(engine.size, 5, '索引条目数');

function names(query, type) {
  return engine.search(query, { type: type || 'all', limit: 20 }).map((r) => r.item.name);
}

// 拼音首字母
const wx = names('wx');
assert(wx.includes('微信聊天记录.xlsx'), 'wx 应命中微信聊天记录');
assert(wx.includes('微信.pcblib'), 'wx 应命中微信.pcblib');
assert.strictEqual(wx[0], '微信.pcblib', '短文件名排序更靠前');

// 全拼
assert(names('weixin').some((n) => n.startsWith('微信')), '全拼 weixin 应命中微信');

// 中文 / 英文 / 路径
assert(names('聊天').includes('微信聊天记录.xlsx'), '中文子串');
assert(names('setup').includes('WeChat Setup.exe'), '英文大小写不敏感');
assert(names('other').length === 2, '路径匹配');

// 空格分词 AND
assert.deepStrictEqual(names('wx xlsx'), ['微信聊天记录.xlsx'], '多个关键词 AND');

// 类型过滤
assert(names('wx', 'dir').length === 0, 'wx 无文件夹命中');
assert(names('项目', 'dir').includes('项目资料'), '文件夹过滤');
assert(names('项目', 'file').length === 0, '文件过滤');

// 高亮映射：wx -> 微信（第 0、1 个字符）
const wxResult = engine.search('wx')[0];
if (wxResult.item.name.startsWith('微信')) {
  assert.deepStrictEqual(wxResult.highlights.slice(0, 2), [
    { start: 0, end: 1 }, { start: 1, end: 2 },
  ], '拼音首字母高亮应映射到原始汉字位置');
}

// 空查询
assert.deepStrictEqual(names(''), [], '空查询返回空');

console.log('SEARCH tests: OK (14 assertions)');
