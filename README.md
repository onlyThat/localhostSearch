# localhostSearch

<p align="center">
  <img src="build/icon.png" width="120" alt="localhostSearch 图标">
</p>

<p align="center">
  <b>敲两个字母就能找到文件 —— 本地文件极速搜索，支持拼音首字母。</b><br>
  不联网 · 无广告 · 无遥测 · 索引只保存在本机
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D6?logo=windows&logoColor=white" alt="Windows 10/11">
  <img src="https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white" alt="Electron 33">
  <img src="https://img.shields.io/badge/Python-3.13-3776AB?logo=python&logoColor=white" alt="Python 3.13">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
  <img src="https://img.shields.io/badge/offline-yes-brightgreen" alt="100% Offline">
</p>

<p align="center">
  <img src="docs/screenshot.png" width="900" alt="localhostSearch 主界面">
</p>

---

## 为什么用它

Windows 自带的搜索框慢、还经常搜不到；装 Everything 又要常驻服务、只能全拼。

| | Windows 搜索 | 常见搜索工具 | localhostSearch |
| --- | --- | --- | --- |
| 速度 | 建索引慢、常卡住 | 快 | **内存内匹配，毫秒级出结果** |
| 中文 | 只能打中文 | 只能打拼音或中文 | **中文 / 全拼 / 首字母三选一** |
| 权限 | — | 多数要常驻服务 | **MFT 要管理员，普通权限自动降级遍历，始终可用** |
| 隐私 | 可能上云 | 部分带云同步 | **纯本地，零网络请求** |
| 体积 | 内置 | 常驻后台 | **便携单文件，关掉即退出** |

## 下载

前往 [**Releases**](../../releases/latest) 下载：

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `localhostSearch-Portable-x.x.x.exe` | ~78 MB | **免安装版**，双击即用，单文件，绿色运行 |

> 索引文件保存在 `%APPDATA%\localhostSearch\localsearch\`，关掉软件不会删除，下次打开秒出结果。

## 功能

**极速索引** — 管理员模式下直读 NTFS 主文件表（MFT），实测 38 万条 27 秒、173 万条 185 秒；未提权时自动降级为目录遍历，功能不受影响。

**三种输入方式** — 同一个「微信」文件，输入 `微信`、`weixin` 或 `wx` 都能找到，命中字符会精确高亮到原文件名对应位置。

**边打边搜** — 输入即搜，无需回车；空格分隔多个关键词做 AND 过滤（如 `wx xlsx`）。

**结果操作** — 双击打开、`Ctrl+Enter` 定位到所在文件夹、`Ctrl+C` 复制完整路径、上下键选择。

**索引设置** — 可指定 MFT / 遍历模式、限定盘符、自定义遍历根目录、手动指定 Python 路径。

### 搜索能力一览

| 输入 | 匹配方式 | 示例命中 |
| --- | --- | --- |
| `微信` | 名称 / 路径中文子串 | `微信聊天记录.xlsx` |
| `weixin` | 全拼 | 同上 |
| `wx` | 拼音首字母 | 同上 |
| `setup` | 英文大小写不敏感 | `WeChat Setup.exe` |
| `other` | 路径片段 | `D:\Other\notes.txt` |
| `wx xlsx` | 多关键词 AND | 仅 `微信聊天记录.xlsx` |

## 安全边界

- **纯本地运行**：无网络请求、无遥测、不上传文件名或路径
- **只读不写**：索引过程只读取目录信息与 MFT 记录，不修改、不删除任何文件
- **索引仅本机**：索引文件存在 `%APPDATA%`，换机器不带过去
- **提权最小化**：只有 MFT 直读需要管理员；拒绝提权也能用，自动降级为普通遍历
- **遍历有边界**：目录遍历会跳过系统目录、缓存、`node_modules`、聊天数据等噪声目录，详见下方技术细节

## 从源码运行

需要 Node.js 20+。仓库内已附带嵌入式 Python 3.13（`runtime/python`），无需另装 Python。

```bash
npm install
npm start            # 开发模式运行
npm test             # 搜索逻辑测试 + MFT 解析器自测
npm run dist         # 打包便携版 exe
```

构建产物输出到 `dist/`，打包配置见 `package.json` 的 `build` 字段。

## 技术细节

<details>
<summary>为什么 MFT 直读比遍历快一个数量级</summary>

Everything 之类的工具并不去递归目录树，而是直接打开 `\\.\C:` 原始卷句柄，顺序读完整个 NTFS 主文件表。每个文件/目录在 MFT 中至少有一条 1KB 记录，记录里带着文件名、父目录引用、时间戳，读完再在内存里还原完整路径。

- 打开原始卷句柄需要管理员权限；未提权时走目录遍历
- 记录按 1024 字节解析，`size` 取 `$FILE_NAME` 属性——与资源管理器显示一致
- 父目录引用让路径可以后续拼装，扫描阶段不需要知道完整路径

</details>

<details>
<summary>拼音表为什么不用 pypinyin</summary>

pypinyin 依赖较重，还要下载词典。这里改用随项目分发的紧凑二进制表 `scanner/pinyin.bin`（约 330KB），直接构建 `codepoint -> 拼音` 映射。表缺失时退化为仅按 ASCII 索引，主流程不受影响。

索引条目预生成三组检索键：`n`（原始名）、`a`（首字母串）、`f`（全拼串），外加 `x`（首字母对应的原字符下标），用于把 `wx` 的高亮精确映射回「微信」两个汉字。

</details>

<details>
<summary>目录遍历的跳过规则</summary>

遍历模式会跳过系统目录、`Program Files`、`AppData`、`node_modules`、`.git`、缓存类目录（`*cache`、`*temp`、`*logs`）、聊天数据（`WeChat`、`*wx*`）、SDK 与 IDE 目录等。一律按目录名精确或片段匹配，不按路径通配。

系统盘默认只索引用户常用目录（桌面、文档、下载、图片、音乐、视频）；其他固定 NTFS 盘直接取根目录，因此 `D:\迅雷下载` 这类目录同样会被收录。

</details>

<details>
<summary>为什么用嵌入式 Python 而不是打包成单个可执行文件</summary>

PyInstaller 之类方案会把解释器、依赖塞进一个 exe，每次启动都要解压到临时目录，冷启动慢且容易被杀软误报。这里的做法更直白：仓库内附带官方 embeddable 包（11MB、23 个文件），Electron 直接 `spawn` 它跑 `scanner.py`，启动快、内存低、行为可预期。

</details>

## 目录结构

```
main.js            主进程：窗口、索引进程调度、IPC
preload.js         contextBridge 白名单桥接
run-electron.js    启动器：清掉 ELECTRON_RUN_AS_NODE 后再拉起 Electron
start.bat          Windows 下双击启动
src/
  core/
    search-engine.js  内存搜索引擎：子序列模糊匹配、拼音映射、打分排序
    index-store.js    JSONL 索引读写
  renderer/
    index.html        页面结构
    styles.css        浅色主题
    app.js            渲染逻辑
scanner/
  scanner.py        索引构建入口：模式选择、进度协议、输出 JSONL
  mft.py            NTFS MFT 直读（ctypes 调 kernel32）
  walk.py           目录遍历降级方案
  pinyin_util.py    拼音表读取与转换
  pinyin.bin        紧凑拼音表
  check_admin.py    权限探测
runtime/python/     嵌入式 Python 3.13
tests/test-search.js 搜索引擎单元测试
build/after-pack.js  打包后裁剪多余语言包
```

## 许可证

[MIT](LICENSE) © 2026 onlyThat