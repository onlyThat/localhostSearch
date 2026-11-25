'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard, dialog } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { SearchEngine } = require('./src/core/search-engine');
const { IndexStore, readJson, writeJson } = require('./src/core/index-store');

const userDir = path.join(app.getPath('userData'), 'localsearch');
const indexPath = path.join(userDir, 'index.jsonl');
const settingsPath = path.join(userDir, 'settings.json');

// 提权重启时用专用参数启动，避免被单实例锁当成“重复进程”直接退出
const isElevatedRelaunch = process.argv.includes('--elevated');

const store = new IndexStore(indexPath);
const engine = new SearchEngine();

let win = null;
let pythonChild = null;
let indexing = false;
let progress = { stage: 'idle', done: 0, path: '', message: '' };
let settings = {
  mode: 'auto',
  drives: [],
  roots: [],
  pythonPath: '',
  lastBuiltAt: 0,
};

function scannerScript() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scanner', 'scanner.py')
    : path.join(__dirname, 'scanner', 'scanner.py');
}

function bundledPython() {
  // 开发态从项目根目录找；打包后从 resources 找（extraResources 解压出来的真实路径）
  const base = app.isPackaged ? process.resourcesPath : __dirname;
  const exe = path.join(base, 'runtime', 'python', 'python.exe');
  return fs.existsSync(exe) ? exe : null;
}

function pythonExecutable() {
  if (settings.pythonPath && fs.existsSync(settings.pythonPath)) return settings.pythonPath;
  const bundled = bundledPython();
  if (bundled) return bundled;
  return process.platform === 'win32' ? 'python' : 'python3';
}

let adminState = null;

function detectAdmin() {
  // 用与 MFT 扫描器相同的 Win32 调用探测，避免 fs.openSync 在设备路径上的假成功
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'scanner', 'check_admin.py')
    : path.join(__dirname, 'scanner', 'check_admin.py');
  try {
    const output = execFileSync(pythonExecutable(), [script], {
      encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.includes('ADMIN_OK');
  } catch {
    return false;
  }
}

function isAdmin() {
  if (adminState === null) adminState = detectAdmin();
  return adminState;
}

function status() {
  return {
    indexing,
    progress,
    admin: isAdmin(),
    count: engine.size,
    meta: engine.meta,
    indexExists: fs.existsSync(indexPath),
    settings,
  };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcastStatus() {
  send('index:status', status());
}

async function loadIndex() {
  if (!(await store.exists())) {
    engine.clear();
    broadcastStatus();
    return;
  }
  try {
    const { entries, meta } = await store.load();
    engine.load(entries, meta);
    if (meta) {
      settings.lastBuiltAt = meta.builtAt;
      await writeJson(settingsPath, settings);
    }
  } catch (err) {
    console.error('加载索引失败', err);
    send('app:error', '加载索引失败: ' + err.message);
  }
  broadcastStatus();
}

function buildIndex(options = {}) {
  return new Promise((resolve) => {
    if (pythonChild) {
      send('app:toast', '已有索引任务正在运行');
      resolve(false);
      return;
    }
    const mode = options.mode || settings.mode || 'auto';
    const args = [scannerScript(), '--mode', mode, '--out', indexPath];
    if ((options.drives || settings.drives || []).length) {
      args.push('--drives', ...(options.drives || settings.drives));
    }
    if ((options.roots || settings.roots || []).length) {
      args.push('--roots', ...(options.roots || settings.roots));
    }

    indexing = true;
    progress = { stage: 'starting', done: 0, path: '', message: '正在启动索引引擎…' };
    broadcastStatus();

    // 清理上次异常退出遗留的临时索引，避免误判
    try {
      const stale = indexPath + '.tmp';
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
    } catch { /* 忽略清理失败 */ }

    let buffer = '';
    let errorDetail = '';
    const child = spawn(pythonExecutable(), args, { windowsHide: true });
    pythonChild = child;

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        if (text.startsWith('PROGRESS|')) {
          const [, stage, done, p] = text.split('|');
          progress = { stage, done: Number(done) || 0, path: p || '', message: '' };
          broadcastStatus();
        } else if (text.startsWith('STATUS|')) {
          progress = { ...progress, message: text.slice(7) };
          broadcastStatus();
        } else if (text.startsWith('ERROR|')) {
          errorDetail = text.slice(6);
        } else if (text.startsWith('DONE|')) {
          progress = { ...progress, stage: 'done', message: '索引完成' };
          broadcastStatus();
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      errorDetail = errorDetail ? errorDetail + ' | ' + text : text;
      send('app:toast', '索引引擎: ' + text.slice(0, 200));
    });
    child.on('error', (err) => {
      indexing = false;
      pythonChild = null;
      send('app:error', '无法启动 Python：' + err.message + '（请在设置中指定 python.exe 路径）');
      broadcastStatus();
      resolve(false);
    });
    child.on('close', async (code) => {
      indexing = false;
      pythonChild = null;
      if (code === 0) {
        await loadIndex();
        send('app:toast', '索引已更新');
        resolve(true);
      } else {
        progress = { stage: 'error', done: 0, path: '', message: `索引失败（退出码 ${code}）` };
        broadcastStatus();
        const detail = errorDetail.trim();
        const message = detail
          ? '索引构建失败：' + detail.slice(0, 240)
          : '索引构建失败，请检查权限或 Python 环境';
        try {
          fs.appendFileSync(
            path.join(userDir, 'last-error.log'),
            `[${new Date().toISOString()}] exit=${code} ${detail || '(no detail)'}\n`
          );
        } catch { /* 忽略日志写入失败 */ }
        send('app:error', message);
        resolve(false);
      }
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    frame: false,
    backgroundColor: '#f6f8fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

function registerIpc() {
  ipcMain.handle('index:status', () => status());
  ipcMain.handle('index:build', (_e, options) => buildIndex(options));
  ipcMain.handle('search:query', (_e, { query, type, limit }) => ({
    results: engine.search(query, { type, limit }),
    took: Date.now(),
    count: engine.size,
  }));
  ipcMain.handle('file:open', async (_e, target) => {
    const err = await shell.openPath(target);
    return err || null;
  });
  ipcMain.handle('file:reveal', (_e, target) => shell.showItemInFolder(target));
  ipcMain.handle('file:copy', async (_e, target) => {
    clipboard.writeText(target);
    return true;
  });
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', async (_e, next) => {
    settings = { ...settings, ...next };
    await writeJson(settingsPath, settings);
    broadcastStatus();
    return settings;
  });
  ipcMain.handle('window:minimize', () => win && win.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('window:close', () => win && win.close());
  ipcMain.handle('app:isAdmin', () => isAdmin());
  ipcMain.handle('app:elevate', () => {
    const q = (s) => String(s).replace(/'/g, "''");
    const exe = q(process.execPath);
    // 打包后 exe 本身就是完整应用；开发态才需要传项目目录。
    // --elevated 让新实例跳过单实例锁，否则它会被旧实例判定为重复而立即退出。
    const arg = app.isPackaged
      ? " -ArgumentList '--elevated'"
      : ` -ArgumentList @('--elevated', '${q(app.getAppPath())}')`;
    const cmd = `Start-Process -FilePath '${exe}'${arg} -Verb RunAs -PassThru | Out-Null`;
    // 不依赖 PATH：Windows 自带 PowerShell 的固定位置优先
    const psFixed = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const powerShell = fs.existsSync(psFixed) ? psFixed : 'powershell.exe';
    execFile(powerShell, ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || '').trim();
          const cancelled = /cancel|取消/i.test(detail);
          send('app:error', cancelled
            ? '已取消提权。若需 MFT 极速索引，请右键 exe →「以管理员身份运行」'
            : '提权失败：' + detail.slice(0, 180));
          return;
        }
        send('app:toast', '已请求管理员启动，正在退出当前实例…');
        setTimeout(() => app.quit(), 400);
      });
    return true;
  });
}

app.whenReady().then(async () => {
  if (!isElevatedRelaunch && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  settings = { ...settings, ...(await readJson(settingsPath, {})) };
  registerIpc();
  createWindow();
  await loadIndex();

  // 首次启动自动建一次索引，用户无需手动操作
  if (!(await store.exists())) {
    buildIndex({});
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
