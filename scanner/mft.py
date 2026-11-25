"""NTFS MFT 直读模块。

Windows 上 Everything 之类的工具并不去遍历目录树，而是直接解析 NTFS 的
Master File Table（主文件表）：每个文件/目录在 MFT 中至少有一条 1KB 左右的
记录，记录里带着文件名、父目录引用、时间戳等信息。顺序读完整个 MFT 再在
内存里还原路径，比递归遍历目录树快一个数量级。

注意：打开 \\\\.\\C: 这类原始卷句柄需要管理员权限。
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import struct
import time
from typing import Iterator

k32 = ctypes.WinDLL("kernel32", use_last_error=True)

GENERIC_READ = 0x80000000
FILE_SHARE_READ = 0x00000001
FILE_SHARE_WRITE = 0x00000002
OPEN_EXISTING = 3
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
FSCTL_GET_NTFS_VOLUME_DATA = 0x00090064
DRIVE_FIXED = 3

# FILE 记录标志
REC_IN_USE = 0x0001
REC_DIRECTORY = 0x0002

# 属性类型
ATTR_STANDARD_INFORMATION = 0x10
ATTR_FILE_NAME = 0x30
ATTR_END = 0xFFFFFFFF


class LARGE_INTEGER(ctypes.Union):
    _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", wintypes.LONG),
                ("QuadPart", ctypes.c_longlong)]


class NTFS_VOLUME_DATA_BUFFER(ctypes.Structure):
    """Winioctl.h 中的 NTFS_VOLUME_DATA_BUFFER，共 88 字节。"""
    _fields_ = [
        ("VolumeSerialNumber", LARGE_INTEGER),
        ("NumberSectors", LARGE_INTEGER),
        ("TotalClusters", LARGE_INTEGER),
        ("FreeClusters", LARGE_INTEGER),
        ("TotalReserved", LARGE_INTEGER),
        ("BytesPerSector", wintypes.DWORD),
        ("BytesPerCluster", wintypes.DWORD),
        ("BytesPerMftRecord", wintypes.DWORD),
        ("ClustersPerMftRecord", wintypes.DWORD),
        ("MftStartLcn", LARGE_INTEGER),
        ("Mft2StartLcn", LARGE_INTEGER),
        ("MftZoneStart", LARGE_INTEGER),
        ("MftZoneEnd", LARGE_INTEGER),
    ]


k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                            wintypes.HANDLE]
k32.DeviceIoControl.restype = wintypes.BOOL
k32.DeviceIoControl.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p,
                                wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
                                ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
k32.SetFilePointerEx.restype = wintypes.BOOL
k32.SetFilePointerEx.argtypes = [wintypes.HANDLE, LARGE_INTEGER,
                                 ctypes.POINTER(LARGE_INTEGER), wintypes.DWORD]
k32.ReadFile.restype = wintypes.BOOL
k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                         ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
k32.CloseHandle.restype = wintypes.BOOL
k32.CloseHandle.argtypes = [wintypes.HANDLE]
k32.GetLogicalDriveStringsW.restype = wintypes.DWORD
k32.GetLogicalDriveStringsW.argtypes = [wintypes.DWORD, wintypes.LPWSTR]
k32.GetDriveTypeW.restype = wintypes.UINT
k32.GetDriveTypeW.argtypes = [wintypes.LPCWSTR]
k32.GetVolumeInformationW.restype = wintypes.BOOL
k32.GetVolumeInformationW.argtypes = [
    wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
    ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
    wintypes.LPWSTR, wintypes.DWORD,
]


def _u16(buf, off):
    return struct.unpack_from("<H", buf, off)[0]


def _u32(buf, off):
    return struct.unpack_from("<I", buf, off)[0]


def _u64(buf, off):
    return struct.unpack_from("<Q", buf, off)[0]


def filetime_to_unix(ft: int) -> float:
    """Windows FILETIME（1601 年起，100ns 单位）转 Unix 秒。"""
    if not ft or ft < 116444736000000000:
        return 0
    return ft / 10_000_000.0 - 11644473600.0


def list_ntfs_fixed_drives() -> list[str]:
    """列出本机固定 NTFS 盘符。

    不依赖 GetLogicalDriveStringsW：某些权限/会话环境下它会漏掉已挂载的盘，
    逐个盘符调用 GetDriveTypeW + GetVolumeInformationW 更可靠。
    """
    result = []
    for code in range(ord("A"), ord("Z") + 1):
        root = chr(code) + ":\\"
        if k32.GetDriveTypeW(root) != DRIVE_FIXED:
            continue
        fs = ctypes.create_unicode_buffer(64)
        ok = k32.GetVolumeInformationW(root, None, 0, None, None, None, fs, 64)
        if ok and fs.value.upper() == "NTFS":
            result.append(root[:2])
    return result


def open_volume(letter: str):
    """打开原始卷句柄。非管理员会抛 PermissionError(5)。"""
    letter = letter.rstrip(":\\/").upper()
    path = "\\\\.\\" + letter + ":"
    handle = k32.CreateFileW(path, GENERIC_READ,
                             FILE_SHARE_READ | FILE_SHARE_WRITE,
                             None, OPEN_EXISTING, 0, None)
    if handle == INVALID_HANDLE_VALUE or not handle:
        err = ctypes.get_last_error()
        if err == 5:
            raise PermissionError("需要管理员权限才能直接读取 NTFS MFT（Win32 错误 5）")
        raise ctypes.WinError(err)
    return handle


def get_volume_data(letter: str):
    handle = open_volume(letter)
    try:
        # 部分 Windows 版本会在 88 字节结构后附带扩展卷数据，
        # 只传 sizeof(NTFS_VOLUME_DATA_BUFFER) 会得到 ERROR_INSUFFICIENT_BUFFER(122)。
        # 分配更大的输出缓冲区，再按结构解析前 88 字节。
        returned = wintypes.DWORD()
        buffer = ctypes.create_string_buffer(512)
        ok = k32.DeviceIoControl(handle, FSCTL_GET_NTFS_VOLUME_DATA, None, 0,
                                 buffer, len(buffer), ctypes.byref(returned), None)
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())
        vd = NTFS_VOLUME_DATA_BUFFER.from_buffer_copy(buffer.raw)
        return handle, vd
    except Exception:
        k32.CloseHandle(handle)
        raise


def apply_fixup(raw: bytearray, sector_size: int, record_size: int) -> bytearray:
    """还原 MFT 记录中被更新序列数组（USA）覆盖的扇区尾字节。"""
    usa_off = _u16(raw, 0x04)
    usa_cnt = _u16(raw, 0x06)
    if usa_cnt <= 1 or usa_off + usa_cnt * 2 > record_size:
        return raw
    usn = bytes(raw[usa_off:usa_off + 2])
    for i in range(1, usa_cnt):
        pos = i * sector_size - 2
        if pos + 2 > record_size:
            break
        if bytes(raw[pos:pos + 2]) == usn:  # 只在确实被 USN 覆盖时替换
            raw[pos:pos + 2] = raw[usa_off + 2 * i:usa_off + 2 * i + 2]
    return raw


def choose_name(names: list[tuple[int, str, int]]) -> tuple[int, str, int] | None:
    """一个文件可能有多个 $FILE_NAME（Win32/DOS/POSIX），取展示效果最好的。

    命名空间: 0=POSIX, 1=Win32, 2=DOS 8.3, 3=Win32&DOS
    """
    if not names:
        return None
    priority = {1: 0, 3: 1, 0: 2, 2: 3}
    return min(names, key=lambda x: priority.get(x[0], 4))


def parse_record(raw: bytearray, record_size: int, sector_size: int,
                 record_no: int = -1) -> dict | None:
    """解析单条 MFT 记录；不是有效的在用记录返回 None。"""
    if len(raw) < record_size or raw[0:4] != b"FILE":
        return None
    raw = apply_fixup(bytearray(raw), sector_size, record_size)
    flags = _u16(raw, 0x16)
    if not (flags & REC_IN_USE):
        return None
    used = min(_u32(raw, 0x18), record_size)
    attr_off = _u16(raw, 0x14)
    if attr_off < 0x30 or attr_off >= used:
        return None

    names: list[tuple[int, str, int]] = []
    sizes: dict[str, int] = {}
    mtime = 0
    pos = attr_off
    while pos + 8 <= used:
        attr_type = _u32(raw, pos)
        if attr_type == ATTR_END:
            break
        attr_len = _u32(raw, pos + 4)
        if attr_len < 8 or pos + attr_len > used:
            break
        nonresident = raw[pos + 8]
        if nonresident == 0 and pos + 24 <= used:
            value_len = _u32(raw, pos + 16)
            value_off = _u32(raw, pos + 20)
            start = pos + value_off
            end = min(start + value_len, used)
            if attr_type == ATTR_FILE_NAME and end - start >= 60:
                parent = _u64(raw, start) & 0xFFFFFFFFFFFF
                name_len = raw[start + 56]
                ns = raw[start + 57]
                try:
                    name = bytes(raw[start + 58:start + 58 + name_len * 2]).decode("utf-16-le")
                except UnicodeDecodeError:
                    name = ""
                if name and "\\" not in name:
                    fn_mtime = _u64(raw, start + 8)
                    names.append((ns, name, parent))
                    sizes[name] = _u64(raw, start + 0x28)  # RealSize
                    if not mtime:
                        mtime = fn_mtime
            elif attr_type == ATTR_STANDARD_INFORMATION and end - start >= 24:
                mtime = _u64(raw, start + 8)  # 最后修改时间，比 $FILE_NAME 更准
        pos += attr_len

    if not names:
        return None
    best = choose_name(names)
    return {
        "record_no": record_no if record_no >= 0 else _u32(raw, 0x2C),
        "sequence": _u16(raw, 0x10),
        "is_dir": bool(flags & REC_DIRECTORY),
        "base": _u64(raw, 0x20) & 0xFFFFFFFFFFFF,
        "names": names,
        "name": best[1],
        "parent": best[2],
        "size": sizes.get(best[1], 0),
        "mtime": filetime_to_unix(mtime),
    }


def iter_raw_records(handle, vd: NTFS_VOLUME_DATA_BUFFER,
                     progress=None) -> Iterator[tuple[int, dict]]:
    """顺序流式读取整个 MFT，避免一次性把几百 MB 读进内存。"""
    rec_size = vd.BytesPerMftRecord
    sector = vd.BytesPerSector
    cluster = vd.BytesPerCluster
    if rec_size < 256 or sector == 0 or cluster == 0:
        raise ValueError("无法获取有效的 NTFS 卷布局")
    start = LARGE_INTEGER(QuadPart=vd.MftStartLcn.QuadPart * cluster)
    if not k32.SetFilePointerEx(handle, start, None, 0):
        raise ctypes.WinError(ctypes.get_last_error())

    batch = 256
    buf = ctypes.create_string_buffer(rec_size * batch)
    index = 0
    empty_batches = 0
    while True:
        read = wintypes.DWORD()
        ok = k32.ReadFile(handle, buf, rec_size * batch, ctypes.byref(read), None)
        if not ok or read.value == 0:
            break
        n = read.value // rec_size
        valid = 0
        for i in range(n):
            rec_no = index * batch + i
            info = parse_record(bytearray(buf.raw[i * rec_size:(i + 1) * rec_size]),
                                rec_size, sector, rec_no)
            if info:
                valid += 1
                yield rec_no, info
        index += 1
        if progress:
            progress(index * batch, info["name"] if valid else "")
        if n < batch:
            break
        if valid == 0:
            empty_batches += 1
            if empty_batches >= 2:  # MFT 尾部未分配区域通常是连续全 0
                break
        else:
            empty_batches = 0


def build_entries(records: dict[int, dict], extensions: dict[int, list[dict]],
                  root: str) -> Iterator[dict]:
    """把记录号 + 父引用还原成完整路径。独立于 Win32 调用，方便单元测试。"""
    for base, extras in extensions.items():
        if base in records:
            for extra in extras:
                records[base]["names"].extend(extra["names"])
                best = choose_name(records[base]["names"])
                records[base]["name"] = best[1]
                records[base]["parent"] = best[2]

    path_cache: dict[int, str | None] = {5: root}

    def resolve(ref: int, depth: int = 0) -> str | None:
        num = ref & 0xFFFFFFFFFFFF
        if num in path_cache:
            return path_cache[num]
        if depth > 96 or num not in records:
            return None
        info = records[num]
        best = choose_name(info["names"])
        if not best:
            path_cache[num] = None
            return None
        parent_path = resolve(best[2], depth + 1)
        if parent_path is None:
            path_cache[num] = None
            return None
        path = (parent_path if parent_path.endswith("\\") else parent_path + "\\") + best[1]
        path_cache[num] = path
        return path

    for rec_no, info in records.items():
        if rec_no < 16:  # 系统元数据文件（$MFT、$LogFile 等）
            continue
        full_path = resolve(rec_no)
        if not full_path:
            continue
        low = full_path.lower()
        if any(x in low for x in ("\\system volume information\\", "\\$recycle.bin\\",
                                  "\\$extend\\", "\\windows\\winsxs\\")):
            continue
        best = choose_name(info["names"])
        yield {
            "p": full_path,
            "n": best[1] if best else info["name"],
            "d": 1 if info["is_dir"] else 0,
            "s": 0 if info["is_dir"] else info.get("size", 0),
            "m": int(info["mtime"]),
        }


def scan_drive(letter: str, progress=None, max_records: int = 0) -> Iterator[dict]:
    """扫描单个 NTFS 盘，产出统一格式的条目 dict。

    max_records 仅用于自测/调试，限制读取的记录数。
    """
    handle, vd = get_volume_data(letter)
    root = letter.rstrip(":\\/").upper() + ":\\"
    records: dict[int, dict] = {}
    extensions: dict[int, list[dict]] = {}
    scanned = 0
    try:
        for rec_no, info in iter_raw_records(handle, vd, progress):
            scanned += 1
            if max_records and scanned > max_records:
                break
            if info["base"]:
                extensions.setdefault(info["base"], []).append(info)
            else:
                records[rec_no] = info

        yield from build_entries(records, extensions, root)
    finally:
        k32.CloseHandle(handle)
