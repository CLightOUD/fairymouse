"""Local hidden-desktop MCP adapter using the pinned lowlevel Win32 backend."""
import ctypes
import io
import re
import subprocess
import threading
from ctypes import wintypes
from pathlib import Path

_user32 = ctypes.WinDLL('user32', use_last_error=True)
_user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
_user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
_user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

from mcp.server.fastmcp import FastMCP, Image
from vendor import winio

winio.user32.GetThreadDesktop.argtypes = [wintypes.DWORD]
winio.user32.GetThreadDesktop.restype = wintypes.HANDLE
winio.user32.GetUserObjectInformationW.argtypes = [
    wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD),
]
winio.user32.GetUserObjectInformationW.restype = wintypes.BOOL
winio.user32.GetWindowDpiAwarenessContext.argtypes = [wintypes.HWND]
winio.user32.GetWindowDpiAwarenessContext.restype = ctypes.c_void_p
winio.user32.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
winio.user32.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p

mcp = FastMCP(
    'fairy-hidden-desktop',
    instructions=(
        'Create a named hidden Win32 desktop, launch a separate application instance, '
        'inspect windows and controls, then act and verify. These tools never switch '
        'the input desktop or send physical input. Use dedicated browser profiles and '
        'application multi-instance flags: singleton apps may redirect to an existing '
        'instance on the user desktop. Files and account are shared. Message input and '
        'PrintWindow do not work in every application. Do not substitute foreground input.'
    ),
    log_level='WARNING',
)


def _name(name):
    if not re.fullmatch(r'FairyHidden-[A-Za-z0-9_-]{1,48}', name):
        raise ValueError('Use a desktop name such as FairyHidden-document; reserved desktops are refused.')
    return name


def _on_desktop(name, operation, hwnd=None):
    _name(name)
    winio.create_desktop(name)
    result = {}

    def worker():
        try:
            if not winio.user32.SetThreadDesktop(winio._DESKTOPS[name]):
                raise OSError('Cannot attach worker to the specified hidden desktop')
            if hwnd is not None:
                thread_id = winio.user32.GetWindowThreadProcessId(hwnd, None)
                desktop = winio.user32.GetThreadDesktop(thread_id) if thread_id else None
                actual_name = ctypes.create_unicode_buffer(256)
                needed = wintypes.DWORD()
                valid = desktop and winio.user32.GetUserObjectInformationW(
                    desktop, 2, actual_name, ctypes.sizeof(actual_name), ctypes.byref(needed))
                if not valid or actual_name.value.casefold() != name.casefold():
                    raise ValueError('Window is not on the specified hidden desktop; refresh hidden_windows')
                context = winio.user32.GetWindowDpiAwarenessContext(hwnd)
                if context:
                    winio.user32.SetThreadDpiAwarenessContext(context)
            result['value'] = operation()
        except Exception as exc:
            result['error'] = exc

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    thread.join(15)
    if thread.is_alive():
        raise TimeoutError('Hidden-window operation timed out; inspect state before retrying')
    if 'error' in result:
        raise result['error']
    return result['value']


@mcp.tool()
def hidden_create(name: str) -> dict:
    """Create/reopen a hidden desktop named FairyHidden-<task>. Never switches the visible desktop."""
    return winio.create_desktop(_name(name))


@mcp.tool()
def hidden_launch(name: str, executable: str, arguments: list[str] | None = None) -> dict:
    """Launch an absolute executable path in a hidden desktop. Use separate app profiles/instances."""
    _name(name)
    path = Path(executable)
    if not path.is_absolute() or not path.is_file():
        raise ValueError('Provide an existing absolute executable path')
    return winio.launch_on_desktop(name, subprocess.list2cmdline([str(path), *(arguments or [])]))


@mcp.tool()
def hidden_windows(name: str) -> list[dict]:
    """Observe current top-level HWNDs, titles, process IDs and sizes on this hidden desktop."""
    def inspect():
        windows = winio.list_desktop_windows(name)
        for window in windows:
            context = winio.user32.GetWindowDpiAwarenessContext(window['handle'])
            previous = winio.user32.SetThreadDpiAwarenessContext(context) if context else None
            try:
                rect = wintypes.RECT()
                if winio.user32.GetWindowRect(window['handle'], ctypes.byref(rect)):
                    window['width'], window['height'] = rect.right-rect.left, rect.bottom-rect.top
            finally:
                if previous:
                    winio.user32.SetThreadDpiAwarenessContext(previous)
        return windows
    return _on_desktop(name, inspect)


@mcp.tool()
def hidden_controls(name: str, hwnd: int) -> list[dict]:
    """Observe child controls. Returned bounds are relative to the outer window, not its client area."""
    return _on_desktop(name, lambda: winio.list_child_windows(hwnd), hwnd)


@mcp.tool()
def hidden_click(name: str, hwnd: int, x: int, y: int, button: str = 'left', double: bool = False) -> dict:
    """Post a click to observed HWND client coordinates. Does not move the physical pointer."""
    if button not in {'left', 'right', 'middle'}:
        raise ValueError('Unsupported button')
    if not (0 <= x < 32768 and 0 <= y < 32768):
        raise ValueError('Use nonnegative client coordinates below 32768')
    return _on_desktop(name, lambda: winio.send_click(hwnd, x, y, button, double), hwnd)


@mcp.tool()
def hidden_set_text(name: str, hwnd: int, text: str) -> dict:
    """Set an observed edit control using WM_SETTEXT; independently verify the changed value."""
    return _on_desktop(name, lambda: winio.set_control_text(hwnd, text), hwnd)


@mcp.tool()
def hidden_type_text(name: str, hwnd: int, text: str) -> dict:
    """Post characters to an observed text control. Some custom applications ignore WM_CHAR."""
    encoded = text.encode('utf-16-le')
    units = ''.join(chr(int.from_bytes(encoded[i:i+2], 'little')) for i in range(0, len(encoded), 2))
    return _on_desktop(name, lambda: winio.send_text(hwnd, units), hwnd)


@mcp.tool()
def hidden_keys(name: str, hwnd: int, keys: list[str]) -> dict:
    """Post key messages to a hidden window. Modifier shortcuts can be ignored; verify their effects."""
    return _on_desktop(name, lambda: winio.send_keys(hwnd, keys), hwnd)


@mcp.tool()
def hidden_screenshot(name: str, hwnd: int, client_only: bool = False) -> Image:
    """Capture this hidden window using PrintWindow. GPU surfaces can be blank; inspect the image."""
    picture, rendered = _on_desktop(name, lambda: winio.capture_window(hwnd, client_only), hwnd)
    if not rendered:
        raise RuntimeError('PrintWindow reported failure')
    data = io.BytesIO()
    picture.save(data, format='PNG')
    return Image(data=data.getvalue(), format='png')


@mcp.tool()
def hidden_close_window(name: str, hwnd: int) -> dict:
    """Request WM_CLOSE for a hidden window. Unsaved-work prompts may require further inspection."""
    def close():
        if not winio.user32.PostMessageW(hwnd, 0x0010, 0, 0):
            raise OSError('WM_CLOSE could not be posted')
        return {'close_requested': True, 'hwnd': hwnd}
    return _on_desktop(name, close, hwnd)


@mcp.tool()
def hidden_release(name: str) -> dict:
    """Release an empty hidden desktop. Close its applications first; never kills processes."""
    windows = hidden_windows(name)
    if windows:
        raise ValueError('Desktop still has windows; close the task applications before releasing it')
    return winio.close_desktop(name)


if __name__ == '__main__':
    mcp.run(transport='stdio')
