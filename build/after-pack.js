// electron-builder 打包后裁剪用不到的 Electron 附带资源。
const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  const dir = context.appOutDir;
  const remove = (relative) => {
    const target = path.join(dir, relative);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      console.log('[trim] removed', relative);
    }
  };

  // 只保留中文和英文语言包，其余 50+ 个 pak 合计约 40MB。
  const locales = path.join(dir, 'locales');
  if (fs.existsSync(locales)) {
    for (const name of fs.readdirSync(locales)) {
      if (name !== 'zh-CN.pak' && name !== 'en-US.pak') {
        remove(path.join('locales', name));
      }
    }
  }

  // Chromium 许可证页面不影响运行。
  remove('LICENSES.chromium.html');

  // SwiftShader 仅用于 WebGL 软件渲染；本应用没有 WebGL 内容。
  remove('vk_swiftshader.dll');
  remove('vk_swiftshader_icd.json');

  // 其余图形/DLL 是 Chromium 加载时依赖的，不能删除。
};
