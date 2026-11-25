"""从 pypinyin 字典生成紧凑拼音表（开发时运行一次）。

生成的 pinyin.bin 格式：
  magic  b'PYT1'
  count  uint32 little endian
  records: codepoint(uint32 LE) + length(uint8) + ASCII pinyin(bytes)

运行时只需要这张表，不再依赖 pypinyin 包。
"""
from __future__ import annotations

import json
import os
import struct
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "vendor", "pypinyin", "pinyin_dict.json")
OUT = os.path.join(HERE, "pinyin.bin")


def normalize(pinyin_with_tone: str) -> str:
    """把带声调拼音转成检索用的 ASCII 形式，ü -> v。"""
    decomposed = unicodedata.normalize("NFD", pinyin_with_tone)
    plain = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return plain.replace("ü", "v").replace("Ü", "v").lower()


def main() -> None:
    with open(SRC, encoding="utf-8") as f:
        raw = json.load(f)

    table: dict[int, str] = {}
    for key, readings in raw.items():
        code = int(key)
        first = readings.split(",")[0]
        norm = normalize(first)
        if not norm or not norm.isascii():
            continue
        table[code] = norm

    with open(OUT, "wb") as f:
        f.write(b"PYT1")
        f.write(struct.pack("<I", len(table)))
        for code in sorted(table):
            value = table[code].encode("ascii")
            f.write(struct.pack("<IB", code, len(value)))
            f.write(value)

    print(f"generated {OUT}: {len(table)} entries, {os.path.getsize(OUT)} bytes")


if __name__ == "__main__":
    main()
