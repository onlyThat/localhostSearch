'use strict';

/**
 * 启动器：某些开发环境会预设 ELECTRON_RUN_AS_NODE=1，
 * 这会让 electron.exe 退化为普通 Node 进程（app 为 undefined）。
 * 这里显式移除该变量后再拉起真正的 Electron 主进程。
 */
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [__dirname], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('error', (err) => {
  console.error('启动 Electron 失败:', err.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code == null ? 0 : code));
