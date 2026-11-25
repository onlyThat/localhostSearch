"""普通权限下的降级方案：递归目录遍历。

直读 MFT 需要管理员权限；未提供提权时仍要能搜文件，所以保留这条路径。
它比 MFT 慢，但搜索阶段同样是内存瞬时匹配。
"""
from __future__ import annotations

import os
from typing import Iterator

# 这些目录遍历价值很低，且容易产生大量噪声、权限错误或体积膨胀。
# 按目录名精确匹配，不按路径后缀，避免误伤 "mywindows" 这类正常目录。
SKIP_DIR_NAMES = {
    "$recycle.bin", "system volume information", "$extend", "$temp",
    "windows", "program files", "program files (x86)", "programdata",
    "appdata", "node_modules", ".git", ".svn", "__pycache__",
    "deliveryoptimization", "onedrivetemp", "wudownloadcache",
    "qqmusiccache", "kugoucache", "cloudmusiccache",
}

# 依赖缓存、聊天数据、SDK 与软件安装目录通常占盘符 90% 以上的条目，
# 但几乎不是用户要找的文档。用名称片段统一过滤，避免索引体积爆炸。
SKIP_DIR_HINTS = (
    "cache", "sdk", "node_modules", "store", "wechat", "weixin",
    "visualstudio", "visual studio", "program files", "windows kits",
    "software", "ruanjian", "appdata", "temp", "tmp", "logs",
    "venv", "site-packages", "gradle", "pnpm", "yarn", "npm",
)


def should_skip_dir(name: str) -> bool:
    low = name.lower()
    if low in SKIP_DIR_NAMES:
        return True
    if low.startswith(".") and low not in (".", ".."):
        return True
    return any(hint in low for hint in SKIP_DIR_HINTS)


def scan_roots(roots: list[str], progress=None) -> Iterator[dict]:
    counter = 0
    for root in roots:
        root = os.path.abspath(root)
        if not os.path.isdir(root):
            continue
        stack = [root]
        while stack:
            current = stack.pop()
            try:
                with os.scandir(current) as it:
                    for entry in it:
                        try:
                            # 跳过符号链接/目录联接，避免循环和越权访问
                            if entry.is_symlink():
                                continue
                            is_dir = entry.is_dir(follow_symlinks=False)
                            counter += 1
                            st = entry.stat(follow_symlinks=False)
                            path = entry.path
                            if is_dir and should_skip_dir(entry.name):
                                continue
                            yield {
                                "p": path,
                                "n": entry.name,
                                "d": 1 if is_dir else 0,
                                "s": 0 if is_dir else st.st_size,
                                "m": int(st.st_mtime),
                            }
                            if is_dir:
                                stack.append(path)
                        except (OSError, PermissionError):
                            continue
            except (OSError, PermissionError):
                continue
            if progress:
                progress(counter, current)
