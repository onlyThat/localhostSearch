"""文件名 -> 拼音首字母 / 全拼。

使用随项目分发的紧凑拼音表 pinyin.bin（约 330KB），不再依赖 pypinyin。
表缺失时退化为仅按 ASCII 字符索引，不会影响主流程。
"""
from __future__ import annotations

import os
import struct

_HERE = os.path.dirname(os.path.abspath(__file__))
_TABLE_PATH = os.path.join(_HERE, "pinyin.bin")


def is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (0x3400 <= code <= 0x9FFF or 0xF900 <= code <= 0xFAFF
            or 0x20000 <= code <= 0x2FA1F)


def _load_table() -> dict[int, str]:
    """读取 pinyin.bin，返回 codepoint -> 无调拼音。"""
    with open(_TABLE_PATH, "rb") as f:
        data = f.read()
    if len(data) < 8 or data[:4] != b"PYT1":
        raise ValueError("invalid pinyin table")
    count = struct.unpack_from("<I", data, 4)[0]
    table: dict[int, str] = {}
    pos = 8
    for _ in range(count):
        code, length = struct.unpack_from("<IB", data, pos)
        pos += 5
        table[code] = data[pos:pos + length].decode("ascii")
        pos += length
    return table


try:
    _TABLE = _load_table()
    _HAS_PINYIN = True
except Exception:  # pragma: no cover - 仅当数据表缺失时触发
    _TABLE = {}
    _HAS_PINYIN = False


class Pinyinizer:
    def __init__(self):
        self._cache: dict[str, str] = {}

    def _pinyin(self, ch: str) -> str:
        cached = self._cache.get(ch)
        if cached is not None:
            return cached
        value = _TABLE.get(ord(ch), "") if is_cjk(ch) else ""
        self._cache[ch] = value
        return value

    def convert(self, name: str) -> tuple[str, str, list[int]]:
        """返回 (首字母串, 全拼串, 首字母对应的原字符下标)。

        例: '微信聊天记录.xlsx' -> ('wxltjlxlsx', 'weixinliaotianjiluxlsx', [0,1,2,...])
        中文以外的字母数字原样保留，标点丢弃。
        """
        first, full, mapping = [], [], []
        for idx, ch in enumerate(name.lower()):
            if is_cjk(ch):
                py = self._pinyin(ch)
                if py:
                    first.append(py[0])
                    mapping.append(idx)
                    full.append(py)
            elif ch.isascii() and ch.isalnum():
                first.append(ch)
                mapping.append(idx)
                full.append(ch)
            # 其余标点符号忽略
        return "".join(first), "".join(full), mapping


def selftest() -> bool:
    py = Pinyinizer()
    first, full, mapping = py.convert("微信聊天记录.xlsx")
    if not _HAS_PINYIN:
        print("WARN: pinyin.bin 未找到，拼音索引降级为关闭")
        return True
    ok = (first == "wxltjlxlsx" and full == "weixinliaotianjiluxlsx"
          and mapping[:4] == [0, 1, 2, 3])
    print(f"PINYIN selftest: {'OK' if ok else 'FAIL'} -> {first} / {full} / {mapping[:6]}")
    return ok
