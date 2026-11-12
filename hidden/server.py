"""Local hidden-desktop MCP adapter using the pinned lowlevel Win32 backend."""
import ctypes
import io
import re
import subprocess
import threading
import time
import sys
import asyncio
import functools
import inspect
import json
from importlib.metadata import version
from ctypes import wintypes
from pathlib import Path
from typing import Literal

_user32 = ctypes.WinDLL('user32', use_last_error=True)
_user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
_user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
_user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

from mcp.server.fastmcp import FastMCP, Image
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from vendor import winio
import observations
from recovery import NativeWorker
import controls
import semantic

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

class FairyMCP(FastMCP):
    async def call_tool(self, name, arguments):
        try:
            return await super().call_tool(name, arguments)
        except Exception as exc:
            return _error(exc)


mcp = FairyMCP(
    'fairy-hidden-desktop',
    instructions=(
        'Create a named hidden Win32 desktop, launch a separate application instance, '
        'inspect windows and controls, then act and verify. These tools never switch '
        'the input desktop or send physical input. Preserve login state; prefer UIA for existing '
        'authenticated windows. Use supported multi-instance options when needed: singleton apps may redirect to an existing '
        'instance on the user desktop. Files and account are shared. Message input and '
        'PrintWindow do not work in every application. Do not substitute foreground input. '
        'Inspect structuredContent.status and isError: posted is not verified. Never automatically '
        'retry mutations or unverified launches. Use hidden_wait to check effects and hidden_status '
        'for busy/timeout diagnostics. Prefer hidden_observe then hidden_act with refs and optional postconditions; '
        'after a mutation observe again. Refs expire after 60 seconds; snapshots can be diff baselines. '
        'Each agent should use its own server process and unique FairyHidden name. A desktop is exclusively '
        'owned until hidden_release or server exit. No physical mouse devices are created. '
        'Requests are not queued; process exit and window closure are distinct.'
    ),
    log_level='WARNING',
)

_inflight = None
_paused = False
_native = NativeWorker()


def _error(exc):
    message = str(exc)
    prefix = message.split(':', 1)[0]
    code = prefix if re.fullmatch(r'[A-Z_]+', prefix) else type(exc).__name__.upper()
    payload = {'status': 'error', 'code': code, 'message': message, 'verified': False,
               'retry_safe': False, 'next_action': 'Observe state before retrying any mutation.'}
    payload['fairy'] = {'version': '1', 'route': 'hidden', 'status': 'error', 'verified': False, 'retry_safe': False, 'code': code, 'message': message}
    return CallToolResult(isError=True, structuredContent=payload,
                          content=[TextContent(type='text', text=json.dumps(payload))])


def tool(read_only=False):
    """Register async MCP handlers with explicit errors and no queued mutations."""
    def register(fn):
        @functools.wraps(fn)
        async def dispatch(**kwargs):
            global _inflight
            reading = read_only or (fn.__name__ == 'hidden_semantic' and kwargs.get('action', 'snapshot') == 'snapshot')
            try:
                if fn.__name__ in {'hidden_status', 'hidden_control'}:
                    value = fn(**kwargs)
                else:
                    if _paused and not reading:
                        raise RuntimeError('PAUSED: new mutations are disabled; reads and status remain available')
                    if _inflight is not None and not _inflight.done():
                        raise RuntimeError('BUSY: another request is running; no action was queued')
                    def execute():
                        if 'name' in kwargs:
                            kwargs['name'] = _name(kwargs['name'])
                        return _native.call(fn.__name__, kwargs)
                    _inflight = asyncio.create_task(asyncio.to_thread(execute))
                    _inflight.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
                    # Client cancellation does not cancel native work or allow overlap.
                    value = await asyncio.shield(_inflight)
                if isinstance(value, Image):
                    return CallToolResult(content=[value.to_image_content()], structuredContent={'fairy': {'version': '1', 'route': 'hidden', 'status': 'observed', 'verified': False, 'retry_safe': True}})
                payload = value if isinstance(value, dict) else {'result': value}
                failed = payload.get('status') in {'verification_failed', 'error'}
                payload['fairy'] = {'version': '1', 'route': 'hidden',
                                    'status': payload.get('status', 'observed' if reading else 'completed_unverified'),
                                    'verified': payload.get('verified', False),
                                    'retry_safe': reading and not failed}
                if failed:
                    payload['fairy'].update({key: payload[key] for key in ('code', 'message') if key in payload})
                return CallToolResult(isError=failed, structuredContent=payload,
                                      content=[TextContent(type='text', text=json.dumps(payload))])
            except Exception as exc:
                return _error(exc)
        dispatch.__signature__ = inspect.signature(fn).replace(return_annotation=CallToolResult)
        dispatch.__annotations__ = {**fn.__annotations__, 'return': CallToolResult}
        mcp.add_tool(dispatch, annotations=ToolAnnotations(readOnlyHint=read_only,
                     destructiveHint=not read_only, idempotentHint=read_only, openWorldHint=True))
        return fn
    return register


def _name(name):
    if not re.fullmatch(r'FairyHidden-[A-Za-z0-9_-]{1,48}', name, re.IGNORECASE):
        raise ValueError('Use a desktop name such as FairyHidden-document; reserved desktops are refused.')
    return name.casefold()


_gate = threading.RLock()
_active = None
_sessions = {}
_processes = {}


def _process_exited(name, pid):
    handle = _processes.get(name, {}).get(pid)
    if handle is None:
        raise ValueError('UNKNOWN_PROCESS: only processes launched by this server can be checked')
    state = winio.kernel32.WaitForSingleObject(handle, 0)
    if state == 0xFFFFFFFF:
        raise OSError('PROCESS_QUERY_FAILED: cannot check process state')
    return state == 0


def _idle():
    if _active is not None and _active.is_alive():
        raise RuntimeError('BUSY_UNKNOWN_OUTCOME: previous operation is still running; do not retry mutations. '
                           'Use hidden_status; no automatic cancellation or replay is performed.')


def _validate_window(name, hwnd, allow_missing=False):
    if not 0 < hwnd < 2**64:
        raise ValueError('INVALID_HANDLE: use a positive observed HWND')
    thread_id = winio.user32.GetWindowThreadProcessId(hwnd, None)
    if not thread_id and allow_missing:
        return False
    desktop = winio.user32.GetThreadDesktop(thread_id) if thread_id else None
    actual_name = ctypes.create_unicode_buffer(256)
    needed = wintypes.DWORD()
    valid = desktop and winio.user32.GetUserObjectInformationW(
        desktop, 2, actual_name, ctypes.sizeof(actual_name), ctypes.byref(needed))
    if not valid or actual_name.value.casefold() != name.casefold():
        # A window can disappear between the thread and desktop queries.
        if allow_missing and not winio.user32.GetWindowThreadProcessId(hwnd, None):
            return False
        raise ValueError('WRONG_DESKTOP_OR_STALE_WINDOW: refresh hidden_windows; no action was sent')
    return True


def _on_desktop(name, operation, hwnd=None, timeout=10):
    # Only one native operation may be in flight. A timed-out PrintWindow cannot
    # safely be killed in a Python thread; retain it and refuse further work.
    with _gate:
        return _on_desktop_locked(name, operation, hwnd, timeout)


def _on_desktop_locked(name, operation, hwnd, timeout):
    global _active
    _idle()
    name = _name(name)
    observations.claim(name)
    _sessions.setdefault(name, {'created_at': time.time(), 'launches': []})
    result = {}

    def worker():
        original = winio.user32.GetThreadDesktop(winio.kernel32.GetCurrentThreadId())
        try:
            winio._operation_deadline.value = time.monotonic() + timeout
            # Create/open on the disposable thread: CreateDesktop can associate
            # its caller with the desktop, making CloseDesktop fail while a
            # persistent executor thread remains attached.
            opened = winio.create_desktop(name)
            if not winio.user32.SetThreadDesktop(winio._DESKTOPS[name]):
                raise OSError('Cannot attach worker to the specified hidden desktop')
            if hwnd is not None:
                _validate_window(name, hwnd)
                context = winio.user32.GetWindowDpiAwarenessContext(hwnd)
                if context:
                    winio.user32.SetThreadDpiAwarenessContext(context)
            result['value'] = opened if operation is None else operation()
        except Exception as exc:
            result['error'] = exc
        finally:
            # Detach explicitly before Python signals thread completion. This
            # changes only this worker's association, never the input desktop.
            if original and not winio.user32.SetThreadDesktop(original):
                result['error'] = OSError('THREAD_DETACH_FAILED: desktop resources may still be in use')

    thread = threading.Thread(target=worker, daemon=True)
    _active = thread
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        raise TimeoutError('TIMEOUT_UNKNOWN_OUTCOME: operation may still execute; inspect hidden_status before continuing')
    if 'error' in result:
        raise result['error']
    return result['value']


@tool()
def hidden_create(name: str) -> dict:
    """Create/reopen a hidden desktop named FairyHidden-<task>. Never switches the visible desktop."""
    name = _name(name)
    # Return the first open/create result, not a second call which always says
    # already_exists after the worker has just created the desktop.
    return _on_desktop(name, None)


@tool()
def hidden_launch(name: str, executable: str, arguments: list[str] | None = None, wait_ms: int = 2000) -> dict:
    """Launch once and look for a same-PID hidden window. Unverified does NOT mean launch failed; never blindly relaunch. Child-process GUI apps require separate observation."""
    name = _name(name)
    if not 0 <= wait_ms <= 5000:
        raise ValueError('INVALID_ARGUMENT: wait_ms must be 0..5000')
    path = Path(executable)
    if not path.is_absolute() or not path.is_file():
        raise ValueError('Provide an existing absolute executable path')
    with _gate:
        def launch():
            result = winio.launch_on_desktop(name, subprocess.list2cmdline([str(path), *(arguments or [])]))
            _processes.setdefault(name, {})[result['pid']] = result.pop('_process_handle')
            return result
        result = _on_desktop(name, launch)
        _sessions[name]['launches'].append({'pid': result['pid'], 'launched_at': time.time()})
        deadline = time.monotonic() + wait_ms / 1000
        while True:
            try:
                windows = _on_desktop(name, lambda: winio.list_desktop_windows(name), timeout=max(.1, deadline-time.monotonic()))
            except Exception as exc:
                result['observation_error'] = str(exc)
                return result
            matches = [w for w in windows if w['process_id'] == result['pid']]
            if matches:
                result.update(status='verified', verified=True, windows=matches,
                              verification_scope='same_pid_window_on_requested_desktop; foreground interference not measured')
                return result
            if time.monotonic() >= deadline:
                return result
            time.sleep(min(.1, max(0, deadline-time.monotonic())))


@tool(read_only=True)
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


@tool(read_only=True)
def hidden_controls(name: str, hwnd: int, text: str | None = None, class_name: str | None = None,
                    control_id: int | None = None) -> list[dict]:
    """Find child controls with optional exact filters. left/top are outer-window coordinates; client_left/client_top are parent client coordinates. Multiple matches remain explicit."""
    controls = _on_desktop(name, lambda: winio.list_child_windows(hwnd), hwnd)
    return [c for c in controls if (text is None or c['text'] == text)
            and (class_name is None or c['class'] == class_name)
            and (control_id is None or c['control_id'] == control_id)]


@tool()
def hidden_click(name: str, hwnd: int, x: int, y: int, button: Literal['left', 'right', 'middle'] = 'left', double: bool = False,
                 coordinate_space: Literal['client', 'screen'] = 'client') -> dict:
    """Post a click to an observed hidden HWND. Client coordinates are the default. screen accepts physical UIA bounds coordinates and maps only inside this HWND's visible child tree with target DPI awareness. Never moves the physical pointer; no automatic semantic-to-message fallback. Verify the application effect separately."""
    if button not in {'left', 'right', 'middle'}:
        raise ValueError('Unsupported button')
    if coordinate_space not in {'client', 'screen'}:
        raise ValueError('INVALID_ARGUMENT: coordinate_space must be client or screen')
    if coordinate_space == 'client' and not (0 <= x < 32768 and 0 <= y < 32768):
        raise ValueError('Use nonnegative client coordinates below 32768')
    def click():
        target, px, py = hwnd, x, y
        if coordinate_space == 'screen':
            mapped = controls.map_screen_point(hwnd, x, y)
            target, px, py = mapped['hwnd'], mapped['x'], mapped['y']
            _validate_window(name, target)
            context = winio.user32.GetWindowDpiAwarenessContext(target)
            if context:
                winio.user32.SetThreadDpiAwarenessContext(context)
        rect = wintypes.RECT()
        if not winio.user32.GetClientRect(target, ctypes.byref(rect)) or not (0 <= px < min(rect.right, 32768) and 0 <= py < min(rect.bottom, 32768)):
            raise ValueError('INVALID_COORDINATES: point is outside the observed HWND client area')
        return winio.send_click(target, px, py, button, double)
    return _on_desktop(name, click, hwnd)


@tool()
def hidden_set_text(name: str, hwnd: int, text: str) -> dict:
    """Set text and immediately verify by bounded readback. Check status/verified; never infer business completion from this value check."""
    if '\0' in text or len(text) > 100000:
        raise ValueError('INVALID_TEXT: NUL is forbidden and text is limited to 100000 characters')
    return _on_desktop(name, lambda: winio.set_control_text(hwnd, text), hwnd)


@tool()
def hidden_type_text(name: str, hwnd: int, text: str) -> dict:
    """Post characters to an observed text control. Some custom applications ignore WM_CHAR."""
    if '\0' in text or len(text) > 4096:
        raise ValueError('INVALID_TEXT: NUL is forbidden; use set_text for more than 4096 characters')
    encoded = text.encode('utf-16-le')
    units = ''.join(chr(int.from_bytes(encoded[i:i+2], 'little')) for i in range(0, len(encoded), 2))
    return _on_desktop(name, lambda: winio.send_text(hwnd, units), hwnd)


@tool()
def hidden_keys(name: str, hwnd: int, keys: list[str]) -> dict:
    """Post key messages to a hidden window. Modifier shortcuts can be ignored; verify their effects."""
    if not 1 <= len(keys) <= 8:
        raise ValueError('INVALID_KEYS: supply 1..8 keys')
    return _on_desktop(name, lambda: winio.send_keys(hwnd, keys), hwnd)


@tool(read_only=True)
def hidden_screenshot(name: str, hwnd: int, client_only: bool = False, max_size: int | None = None) -> Image:
    """Capture this hidden window using PrintWindow. GPU surfaces can be blank; inspect the image."""
    if max_size is not None and not 64 <= max_size <= 4096:
        raise ValueError('INVALID_ARGUMENT: max_size must be 64..4096')
    picture, rendered = _on_desktop(name, lambda: winio.capture_window(hwnd, client_only), hwnd)
    if not rendered:
        raise RuntimeError('PrintWindow reported failure')
    data = io.BytesIO()
    if max_size is not None:
        picture.thumbnail((max_size, max_size))
    picture.save(data, format='PNG')
    return Image(data=data.getvalue(), format='png')


@tool()
def hidden_close_window(name: str, hwnd: int) -> dict:
    """Request WM_CLOSE for a hidden window. Unsaved-work prompts may require further inspection."""
    def close():
        if not winio.user32.PostMessageW(hwnd, 0x0010, 0, 0):
            raise OSError('WM_CLOSE could not be posted')
        return {'close_requested': True, 'hwnd': hwnd, 'status': 'posted', 'verified': False, 'retry_safe': False}
    return _on_desktop(name, close, hwnd)


@tool()
def hidden_release(name: str) -> dict:
    """Release an empty hidden desktop. Close its applications first; never kills processes."""
    name = _name(name)
    with _gate:
        _idle()
        windows = hidden_windows(name)
        if windows:
            raise ValueError('DESKTOP_NOT_EMPTY: close task windows and verify before releasing')
        if any(not _process_exited(name, pid) for pid in _processes.get(name, {})):
            raise ValueError('DESKTOP_IN_USE: a launched process is still running; use hidden_wait process_exited')
        result = winio.close_desktop(name)
        for handle in _processes.pop(name, {}).values():
            winio.kernel32.CloseHandle(handle)
        _sessions.pop(name, None)
        observations.release(name)
        return result


@tool(read_only=True)
def hidden_status() -> dict:
    """Nonblocking diagnostics and in-memory session inventory, even after a native timeout. PIDs are historical launch records, not proof of ownership/liveness. Reopen a known desktop name after restart."""
    # Do not take _gate: this must stay available while a native call is stuck.
    return {'status': 'busy' if ((_active is not None and _active.is_alive()) or
                               (_inflight is not None and not _inflight.done())) else 'ready',
            'python': sys.version.split()[0], 'mcp': version('mcp'), 'pillow': version('pillow'),
            'sessions': [{'name': name, 'created_at': item['created_at'], 'launches': list(item['launches'])}
                         for name, item in list(_sessions.items())], 'session_scope': 'current_server_process',
            'physical_input': False, 'desktop_switching': False, 'automatic_retry': False, 'parallelism': 'one server per agent; distinct desktop names',
            'owned_desktops': list(observations._locks), 'paused': _paused,
            'worker_generation': _native.generation, 'last_recovery': _native.last_recovery,
            'supervised_processes': {n: list(pids) for n, pids in _native.processes.items()}}


@tool()
def hidden_control(action: Literal['status', 'pause', 'resume', 'recover'] = 'status') -> dict:
    """Control this server. Pause blocks NEW mutations, not already-admitted work. Reads remain available. Resume/recover require idle and recycle only our worker, invalidate refs, preserve application processes and desktop ownership. Never replay actions."""
    global _paused
    if action == 'pause':
        _paused = True
    elif action in {'resume', 'recover'}:
        if _inflight is not None and not _inflight.done():
            raise RuntimeError('BUSY: wait for current request deadline before resume/recover')
        _native.reset(action)
        if action == 'resume':
            _paused = False
    elif action != 'status':
        raise ValueError('INVALID_ARGUMENT: unsupported control action')
    return {'status': 'paused' if _paused else 'ready', 'paused': _paused,
            'inflight': _inflight is not None and not _inflight.done(), 'worker_generation': _native.generation}


@tool(read_only=True)
def hidden_wait(name: str, condition: Literal['window_exists', 'window_closed', 'text_equals', 'process_exited'], hwnd: int | None = None, text: str | None = None,
                process_id: int | None = None, timeout_ms: int = 3000) -> dict:
    """Bounded read-only wait: window_exists (exact title/PID), window_closed (top HWND), text_equals (HWND + exact text), process_exited (PID launched by this server). Never replays actions. A closed window does not prove process exit."""
    name = _name(name)
    if condition not in {'window_exists', 'window_closed', 'text_equals', 'process_exited'} or not 0 <= timeout_ms <= 10000:
        raise ValueError('INVALID_ARGUMENT: supported condition required; timeout_ms must be 0..10000')
    if condition in {'window_closed', 'text_equals'} and hwnd is None:
        raise ValueError('INVALID_ARGUMENT: hwnd is required')
    if condition == 'text_equals' and text is None:
        raise ValueError('INVALID_ARGUMENT: text is required')
    if condition == 'window_closed' and (text is not None or process_id is not None):
        raise ValueError('INVALID_ARGUMENT: window_closed only accepts hwnd, not title/PID filters')
    if condition == 'process_exited' and (process_id is None or hwnd is not None or text is not None):
        raise ValueError('INVALID_ARGUMENT: process_exited requires only process_id')
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        budget = max(.05, deadline-time.monotonic())
        if condition == 'process_exited':
            matched = _process_exited(name, process_id)
            matches = []
        elif condition == 'window_closed':
            matched = _on_desktop(name, lambda: not _validate_window(name, hwnd, allow_missing=True), timeout=budget)
            matches = []
        elif condition == 'text_equals':
            matched = _on_desktop(name, lambda: winio._get_window_text(hwnd) == text, hwnd, timeout=budget)
            matches = []
        else:
            windows = _on_desktop(name, lambda: winio.list_desktop_windows(_name(name)), timeout=budget)
            matches = [w for w in windows if (hwnd is None or w['handle'] == hwnd)
                       and (text is None or w['title'] == text)
                       and (process_id is None or w['process_id'] == process_id)]
            matched = not matches if condition == 'window_closed' else bool(matches)
        if matched or time.monotonic() >= deadline:
            return {'status': 'verified' if matched else 'not_observed', 'verified': matched,
                    'condition': condition, 'windows': matches, 'retry_safe': True}
        time.sleep(min(.1, max(0, deadline-time.monotonic())))


@tool(read_only=True)
def hidden_observe(name: str, hwnd: int, baseline: str | None = None,
                   text: str | None = None, limit: int = 100) -> dict:
    """Observe a window's child controls with short-lived refs. Optional baseline returns only added/removed/changed fields. Ref lifetime 60s, 32 snapshots; geometry/text changes invalidate actions. Null ref means identity unavailable. Filters apply to output, never silently pick a match."""
    name = _name(name)
    if not 1 <= limit <= 500:
        raise ValueError('INVALID_ARGUMENT: limit must be 1..500')
    def observe():
        previous = observations.snapshot(baseline, name, hwnd) if baseline else None
        rows = winio.list_child_windows(hwnd)
        if len(rows) > 500 or sum(len(r.get('text') or '') for r in rows) > 131072:
            raise ValueError('OBSERVATION_TOO_LARGE: observation budget exceeded (500 controls / 128K text characters); inspect a smaller parent')
        key, entries = observations.remember(name, hwnd, rows)
        result = {'snapshot': key, 'scope_hwnd': hwnd, 'total': len(entries), 'expires_in_seconds': 60}
        if previous:
            diff = observations.difference(previous['entries'], entries)
            # Filter diffs by live matching targets; removals remain explicit.
            if text is not None:
                handles = {e['handle'] for e in entries if text in (e.get('text') or '')}
                diff['added'] = [e for e in diff['added'] if e['handle'] in handles]
                diff['changed'] = [e for e in diff['changed'] if e['handle'] in handles]
            result['truncated'] = any(len(v) > limit for v in diff.values())
            result['diff'] = {k: v[:limit] for k, v in diff.items()}
        else:
            selected = [observations.public(e) for e in entries if text is None or text in (e.get('text') or '')]
            result.update(controls=selected[:limit], truncated=len(selected) > limit)
        return result
    return _on_desktop(name, observe, hwnd)


@tool()
def hidden_semantic(name: str, hwnd: int, action: Literal['snapshot', 'click', 'expand', 'collapse', 'set_value'] = 'snapshot',
                    ref: str | None = None, value: str | None = None) -> dict:
    """Observe hidden UIA menus/custom controls or act once on a fresh semantic ref. Uses the existing headless native backend, never physical input or focus. Scope is one top-level HWND on the named desktop. Snapshot refs expire after 60 seconds and are consumed by mutations. A successful click/value readback is NOT a saved file; verify business effects independently."""
    name = _name(name)
    _validate_window(name, hwnd)
    if action != 'snapshot':
        observations.invalidate(name)
    native = semantic.run(name, hwnd, action, ref, value)
    data = native.get('data', {})
    if not native.get('ok'):
        error = native.get('error', {})
        return {'status': 'error', 'verified': False, 'retry_safe': False,
                'code': error.get('code', 'SEMANTIC_FAILED'), 'message': error.get('message', 'Native operation failed'), 'native': native}
    verified = data.get('disposition', {}).get('delivery') == 'delivered_verified'
    return {'status': 'observed' if action == 'snapshot' else ('verified' if verified else 'completed_unverified'),
            'verified': verified, 'retry_safe': action == 'snapshot', 'data': data,
            'verification_scope': 'element only; application commit requires independent verification'}


@tool()
def hidden_act(name: str, ref: str, action: Literal['click', 'set_text', 'replace_text', 'check', 'uncheck', 'select', 'scroll'], text: str | None = None,
               value: int | None = None,
               expect_ref: str | None = None, expect_text: str | None = None, timeout_ms: int = 2000) -> dict:
    """Act ONCE on a fresh observed ref, optionally waiting for exact text at another observed ref. Returns action and verification separately. Never retries a click. Target text/geometry changes require a new observation. Does not claim business completion from a visual change."""
    name = _name(name)
    if (expect_ref is None) != (expect_text is None) or not 0 <= timeout_ms <= 5000:
        raise ValueError('INVALID_ARGUMENT: provide expect_ref and expect_text together; timeout_ms 0..5000')
    if action in {'set_text', 'replace_text'} and (text is None or '\0' in text or len(text) > 100000):
        raise ValueError('INVALID_TEXT: set_text needs text without NUL, maximum 100000 characters')
    if action not in {'set_text', 'replace_text'} and text is not None:
        raise ValueError('INVALID_ARGUMENT: click does not accept text')
    if action not in {'click', 'set_text', 'replace_text', 'check', 'uncheck', 'select', 'scroll'}:
        raise ValueError('INVALID_ARGUMENT: unsupported action')
    def perform():
        target = observations.resolve(ref, name)
        _validate_window(name, target['handle'])
        context = winio.user32.GetWindowDpiAwarenessContext(target['handle'])
        if context:
            winio.user32.SetThreadDpiAwarenessContext(context)
        expected = observations.resolve(expect_ref, name) if expect_ref else None
        if expected:
            _validate_window(name, expected['handle'])
        # Consume all refs for this desktop before a mutation, even on unknown outcomes.
        observations.invalidate(name)
        if action == 'set_text':
            outcome = winio.set_control_text(target['handle'], text)
        elif action == 'replace_text':
            outcome = controls.run(target['handle'], action, text)
        elif action in {'check', 'uncheck', 'select', 'scroll'}:
            outcome = controls.run(target['handle'], action, value)
        else:
            rect = wintypes.RECT()
            if not winio.user32.GetClientRect(target['handle'], ctypes.byref(rect)) or rect.right <= 0 or rect.bottom <= 0:
                raise ValueError('STALE_REF: target has no clickable client area')
            outcome = winio.send_click(target['handle'], rect.right//2, rect.bottom//2)
        result = {'status': outcome['status'], 'action': outcome, 'retry_safe': False,
                  'verified': outcome.get('verified', False)}
        if outcome['status'] == 'verification_failed':
            return result
        if expected:
            deadline = time.monotonic() + timeout_ms/1000
            while True:
                try:
                    _validate_window(name, expected['handle'])
                    current = observations.identity(expected['handle'])
                    # Text is expected to change; all other identity fields must remain stable.
                    if current[:-1] != expected['_identity'][:-1]:
                        raise ValueError('STALE_REF: verification target identity or geometry changed')
                    matched = current[-1] == expect_text
                except Exception as exc:
                    result.update(status='verification_unknown', verified=False,
                                  verification={'status': 'unknown', 'error': str(exc)})
                    return result
                if matched or time.monotonic() >= deadline:
                    result.update(status='verified' if matched else 'not_observed', verified=matched,
                                  verification={'status': 'verified' if matched else 'not_observed',
                                                'condition': 'text_equals'})
                    return result
                time.sleep(min(.05, max(0, deadline-time.monotonic())))
        return result
    return _on_desktop(name, perform, timeout= min(10, timeout_ms/1000 + 3))


if __name__ == '__main__':
    mcp.run(transport='stdio')
