"""可靠的管理员权限探测：真正打开原始卷句柄。

Node 的 fs.openSync('\\\\.\\C:') 在这个路径上会“假成功”（随后读取报 EISDIR），
因此 Electron 主进程改用这段 Python 探测，和 MFT 扫描器使用完全相同的 Win32 调用。
"""
import ctypes
import sys
from ctypes import wintypes

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                            wintypes.HANDLE]
k32.CloseHandle.argtypes = [wintypes.HANDLE]

volume = "\\\\.\\C:"  # \\.\C:
handle = k32.CreateFileW(volume, 0x80000000, 3, None, 3, 0, None)
if handle == ctypes.c_void_p(-1).value or not handle:
    sys.exit(1)
k32.CloseHandle(handle)
print("ADMIN_OK")
