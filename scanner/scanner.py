#!/usr/bin/env python3
"""localhostSearch 索引构建器。

用法示例:
  python scanner.py --mode auto --out data/index.jsonl
  python scanner.py --mode mft --drives C: D: --out data/index.jsonl
  python scanner.py --mode walk --roots "C:\\Users\\me\\Documents" --out data/index.jsonl

stdout 协议（Electron 主进程会解析）:
  STATUS|文本
  PROGRESS|阶段|已处理数量|当前路径
  DONE|总数|耗时秒|模式
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
from itertools import chain

# Electron 以管道启动子进程时，Windows 区域设置可能让 stdout 仍是 GBK。
# 文件名里的 emoji（如 U+1F6AC）会导致 UnicodeEncodeError 中断整次索引。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import mft  # noqa: E402
import walk  # noqa: E402
from pinyin_util import Pinyinizer, selftest as pinyin_selftest, _HAS_PINYIN  # noqa: E402


def emit(line: str) -> None:
    print(line, flush=True)


def guarded(sources, label: str):
    """单个盘符/目录出错时只跳过它，不让整次索引失败。"""
    try:
        for item in sources:
            yield item
    except Exception as exc:
        emit(f"STATUS|{label} 扫描中断：{type(exc).__name__}: {exc}")


def progress_reporter(stage: str):
    def report(done: int, path: str = ""):
        emit(f"PROGRESS|{stage}|{done}|{path[:160]}")
    return report


def default_roots() -> list[str]:
    """默认真正“全局”索引。

    系统盘只取用户常用目录（跳过 Windows/Program Files/AppData 等噪声）；
    其他固定 NTFS 盘直接取根目录，这样 D:\\迅雷下载 这类目录也会被收录。
    """
    home = os.path.expanduser("~")
    names = ("Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos")
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    system_drive = os.path.splitdrive(system_root)[0].rstrip(":\\/").upper()

    roots: list[str] = []
    for drive in mft.list_ntfs_fixed_drives():
        letter = drive.rstrip(":\\/").upper()
        if letter == system_drive:
            for name in names:
                candidate = os.path.join(home, name)
                if os.path.isdir(candidate):
                    roots.append(candidate)
            if not any(r.startswith(home) for r in roots):
                roots.append(home)
        else:
            # 保留盘符冒号：D: -> D:\（rstrip 去掉冒号会变成无效的 D\）
            root = drive.rstrip("\\/") + os.sep
            if os.path.isdir(root):
                roots.append(root)

    if not roots:
        # 极端情况（无 NTFS 固定盘）回退到原来的用户目录集合
        roots = [os.path.join(home, name) for name in names
                 if os.path.isdir(os.path.join(home, name))] or [home]
    # 去重且保持顺序
    return list(dict.fromkeys(os.path.abspath(r) for r in roots))


def build(args) -> int:
    started = time.time()
    py = Pinyinizer()
    mode = args.mode
    sources = []
    drives: list[str] = []
    roots: list[str] = []

    if mode in ("auto", "mft"):
        drives = args.drives or mft.list_ntfs_fixed_drives()
        accessible = []
        for d in drives:
            try:
                h = mft.open_volume(d)
                mft.k32.CloseHandle(h)
                accessible.append(d)
            except PermissionError:
                emit("STATUS|MFT 模式需要管理员权限，当前进程未提权")
            except OSError as exc:
                emit(f"STATUS|无法打开卷 {d}: {exc}")
        if accessible:
            sources = chain.from_iterable(
                guarded(mft.scan_drive(d, progress_reporter("mft:" + d), args.max_records),
                        "MFT " + d)
                for d in accessible)
            emit(f"STATUS|MFT 直读模式: {', '.join(accessible)}")
        elif mode == "mft":
            # 用户可能手动选了 MFT 但没有提权。直接失败对用户没有价值，
            # 自动降级到目录遍历并明确告知，保证工具始终可用。
            emit("STATUS|MFT 不可用，已自动降级为目录遍历模式")
            mode = "walk"
        else:
            mode = "walk"

    if mode == "walk":
        # 用户在设置里只填了盘符时，把它当作该盘根目录，方便多盘机器按需选择。
        drives = args.drives or []
        roots = args.roots
        if not roots and args.drives:
            roots = [d.rstrip("\\/") + os.sep for d in args.drives]
        roots = roots or default_roots()
        roots = [os.path.abspath(r) for r in roots if os.path.isdir(os.path.abspath(r))]
        if not roots:
            # 盘符输入无效时不要生成空索引，回退到自动检测
            roots = [os.path.abspath(r) for r in default_roots()]
        emit("STATUS|目录遍历模式（未提权或用户选择）: " + ", ".join(roots))
        sources = chain.from_iterable(
            guarded(walk.scan_roots([r], progress_reporter("walk")), "目录 " + r)
            for r in roots)

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    count = 0
    # backslashreplace 保证极少数含孤立代理项的文件名不会中断整次索引
    with open(tmp, "w", encoding="utf-8", newline="\n", errors="backslashreplace") as f:
        for entry in sources:
            first, full, mapping = py.convert(entry["n"])
            entry["a"] = first
            entry["f"] = full
            if mapping:
                entry["x"] = ",".join(str(i) for i in mapping)
            f.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
            count += 1
            if count % 2000 == 0:
                emit(f"STATUS|已索引 {count} 个条目")
        meta = {
            "_meta": True,
            "version": 1,
            "mode": mode,
            "drives": drives,
            "roots": roots,
            "builtAt": int(time.time()),
            "count": count,
            "elapsed": round(time.time() - started, 2),
            "pinyin": _HAS_PINYIN,
        }
        f.write(json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(tmp, out)
    emit(f"DONE|{count}|{round(time.time() - started, 2)}|{mode}")
    return 0


def build_fake_record(name: str = "微信.txt", parent: int = 5, size: int = 12345) -> bytearray:
    """构造一条最小合法的 FILE 记录，用于无管理员权限的解析器自测。"""
    rec = bytearray(1024)
    rec[0:4] = b"FILE"
    struct.pack_into("<H", rec, 0x04, 0x30)   # USA 偏移
    struct.pack_into("<H", rec, 0x06, 3)      # USA 项数（1024/512+1）
    rec[0x30:0x32] = b"\xaa\xbb"             # USN
    struct.pack_into("<H", rec, 0x10, 1)      # 序列号
    struct.pack_into("<H", rec, 0x14, 0x38)   # 首个属性偏移
    struct.pack_into("<H", rec, 0x16, 1)      # in use, 非目录
    struct.pack_into("<I", rec, 0x2C, 42)     # 记录号

    # $STANDARD_INFORMATION: 24 字节头 + 24 字节值
    pos = 0x38
    struct.pack_into("<II", rec, pos, 0x10, 0x30)
    rec[pos + 8] = 0
    struct.pack_into("<II", rec, pos + 16, 24, 24)
    struct.pack_into("<Q", rec, pos + 24 + 8, 133000000000000000)

    # $FILE_NAME: 24 字节头 + 58 字节固定部分 + UTF-16 名称
    pos = 0x68
    nb = name.encode("utf-16-le")
    value_len = 58 + len(nb)
    attr_len = (24 + value_len + 7) // 8 * 8
    struct.pack_into("<II", rec, pos, 0x30, attr_len)
    rec[pos + 8] = 0
    struct.pack_into("<II", rec, pos + 16, value_len, 24)
    v = pos + 24
    struct.pack_into("<Q", rec, v, parent)
    struct.pack_into("<Q", rec, v + 8, 133000000000000000)
    struct.pack_into("<Q", rec, v + 0x28, size)
    rec[v + 56] = len(name)
    rec[v + 57] = 1  # Win32 命名空间
    rec[v + 58:v + 58 + len(nb)] = nb
    struct.pack_into("<I", rec, pos + attr_len, 0xFFFFFFFF)
    struct.pack_into("<I", rec, 0x18, pos + attr_len + 4)
    return rec


def selftest() -> int:
    ok = True
    rec = build_fake_record()
    info = mft.parse_record(rec, 1024, 512, 42)

    def fake_info(name, parent, is_dir=False, size=0):
        return {
            "record_no": 0, "sequence": 1, "is_dir": is_dir, "base": 0,
            "names": [(1, name, parent)], "name": name, "parent": parent,
            "size": size, "mtime": 1700000000,
        }

    records = {
        5: fake_info("", 5, True),
        20: fake_info("Work", 5, True),
        42: fake_info("微信.txt", 20, False, 123),
    }
    entries = list(mft.build_entries(records, {}, "C:\\"))

    checks = [
        ("路径还原", len(entries) == 2 and any(
            e["p"] == "C:\\Work\\微信.txt" and e["s"] == 123 for e in entries)),
        ("记录名", info and info["name"] == "微信.txt"),
        ("父记录", info and info["parent"] == 5),
        ("文件大小", info and info["size"] == 12345),
        ("时间戳", info and info["mtime"] > 0),
        ("已删除记录", mft.parse_record(bytes(1024), 1024, 512) is None),
        ("坏签名", mft.parse_record(bytearray(b"XXXX" + bytes(1020)), 1024, 512) is None),
    ]
    for label, passed in checks:
        print(f"MFT selftest - {label}: {'OK' if passed else 'FAIL'}")
        ok = ok and bool(passed)
    ok = pinyin_selftest() and ok
    print("SELFTEST " + ("OK" if ok else "FAIL"))
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="localhostSearch 索引构建器")
    parser.add_argument("--mode", choices=["auto", "mft", "walk"], default="auto")
    parser.add_argument("--drives", nargs="*", help="要扫描的 NTFS 盘符，如 C: D:")
    parser.add_argument("--roots", nargs="*", help="目录遍历模式的扫描根目录")
    parser.add_argument("--out", help="索引输出文件（JSONL）")
    parser.add_argument("--max-records", type=int, default=0, help="调试用：最多读取的记录数")
    parser.add_argument("--selftest", action="store_true", help="运行内置自测")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    if not args.out:
        parser.error("缺少 --out 参数")
    try:
        return build(args)
    except Exception as exc:
        emit(f"ERROR|{type(exc).__name__}: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
