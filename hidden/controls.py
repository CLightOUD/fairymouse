"""Bounded messages for standard controls on an already validated hidden HWND.

Caller must attach to and verify the desktop; this module never resolves another
desktop, changes focus, or sends physical input. Application-specific controls
are rejected instead of guessing.
"""
import ctypes
from ctypes import wintypes
from vendor import winio

winio.user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
winio.user32.GetWindowLongW.restype = ctypes.c_long
winio.user32.GetParent.argtypes = [wintypes.HWND]
winio.user32.GetParent.restype = wintypes.HWND
winio.user32.IsWindowEnabled.argtypes = [wintypes.HWND]
winio.user32.IsWindowEnabled.restype = wintypes.BOOL
winio.user32.IsWindowVisible.argtypes = [wintypes.HWND]
winio.user32.IsWindowVisible.restype = wintypes.BOOL
winio.user32.IsChild.argtypes = [wintypes.HWND, wintypes.HWND]
winio.user32.IsChild.restype = wintypes.BOOL
winio.user32.SetThreadDpiAwarenessContext.argtypes = [wintypes.HANDLE]
winio.user32.SetThreadDpiAwarenessContext.restype = wintypes.HANDLE
winio.user32.GetWindowDpiAwarenessContext.argtypes = [wintypes.HWND]
winio.user32.GetWindowDpiAwarenessContext.restype = wintypes.HANDLE
winio.user32.GetAwarenessFromDpiAwarenessContext.argtypes = [wintypes.HANDLE]
winio.user32.GetAwarenessFromDpiAwarenessContext.restype = ctypes.c_int
winio.user32.PhysicalToLogicalPointForPerMonitorDPI.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
winio.user32.PhysicalToLogicalPointForPerMonitorDPI.restype = wintypes.BOOL
winio.user32.EnumChildWindows.argtypes = [wintypes.HWND, winio.WNDENUMPROC, wintypes.LPARAM]


def map_screen_point(hwnd, x, y):
    """Hit-test a physical UIA point within an already validated hidden HWND tree.

    Read-only mapping; never query a main-desktop window by point. The caller
    must validate/attach the named desktop and validate the returned HWND again
    immediately before dispatching its bounded message.
    """
    if any(isinstance(v, bool) or not isinstance(v, int) or not -(2**31) <= v < 2**31 for v in (x,y)):
        raise ValueError('INVALID_ARGUMENT: physical screen coordinates must be signed 32-bit integers')
    u=winio.user32
    previous=winio._check(u.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4)), 'SetThreadDpiAwarenessContext per-monitor-v2')
    try:
        count=0
        @winio.WNDENUMPROC
        def count_child(handle, unused):
            nonlocal count
            count+=1
            return count<=500
        u.EnumChildWindows(hwnd,count_child,0)
        if count>500:
            raise ValueError('CONTROL_LIMIT: target has more than 500 native child windows')
        target=hwnd
        visited=set()
        for _ in range(501):  # root plus at most 500 children; reject cycles/races
            if target in visited:
                raise ValueError('STALE_WINDOW: cyclic native child hit-test')
            visited.add(target)
            if target != hwnd and not u.IsChild(hwnd,target):
                raise ValueError('STALE_WINDOW: mapped child no longer belongs to target')
            if not u.IsWindowVisible(target):
                raise ValueError('POINT_OUTSIDE_WINDOW: mapped window is no longer visible')
            context=winio._check(u.GetWindowDpiAwarenessContext(target),'GetWindowDpiAwarenessContext')
            winio._check(u.SetThreadDpiAwarenessContext(context),'SetThreadDpiAwarenessContext target')
            awareness=u.GetAwarenessFromDpiAwarenessContext(context)
            if awareness not in {0,1,2}:
                raise RuntimeError('POINT_MAPPING_FAILED: unknown target DPI awareness')
            # Recompute from the same physical point for every HWND. Reusing a
            # parent's logical coordinates breaks mixed-DPI child windows.
            point=wintypes.POINT(x,y)
            if awareness<2:
                winio._check(u.PhysicalToLogicalPointForPerMonitorDPI(target,ctypes.byref(point)), 'PhysicalToLogicalPointForPerMonitorDPI')
            winio._check(u.ScreenToClient(target,ctypes.byref(point)), 'ScreenToClient')
            rect=wintypes.RECT()
            winio._check(u.GetClientRect(target,ctypes.byref(rect)), 'GetClientRect')
            if not (rect.left <= point.x < rect.right and rect.top <= point.y < rect.bottom):
                raise ValueError('POINT_OUTSIDE_WINDOW: mapped point is outside target client bounds')
            child=u.ChildWindowFromPointEx(target,point,0x0001|0x0004)
            if not child:
                raise ValueError('STALE_WINDOW: native hit-test no longer contains point')
            child=int(child)
            if child==target:
                return {'hwnd':target,'x':point.x,'y':point.y}
            if not u.IsChild(hwnd,child) or u.GetParent(child)!=target:
                raise ValueError('STALE_WINDOW: native hit-test escaped the direct child tree')
            target=child
        raise ValueError('CONTROL_LIMIT: native child hit-test exceeded 500 descendants')
    finally:
        winio._check(u.SetThreadDpiAwarenessContext(previous),'RestoreThreadDpiAwarenessContext')


def _kind(hwnd):
    name = winio._get_class_name(hwnd).upper()
    if name in {'RICHEDIT', 'RICHEDIT20A', 'RICHEDIT20W', 'RICHEDIT50W', 'RICHEDITD2DPT'}:
        return 'RICHEDIT'
    for kind in ('BUTTON', 'COMBOBOX', 'LISTBOX', 'EDIT'):
        if name == kind or name.startswith('WINDOWSFORMS10.' + kind + '.'):
            return kind
    raise ValueError('UNSUPPORTED_CONTROL: only standard Button, ComboBox, ListBox and Edit controls are supported')


def _result(hwnd, before, after, expected, scope):
    verified = after == expected
    return {'target_hwnd': hwnd, 'status': 'verified' if verified else 'verification_failed',
            'verified': verified, 'retry_safe': False, 'before': before, 'after': after,
            'changed': before != after, 'verification_scope': scope}


def _notify(hwnd, notification):
    parent = winio.user32.GetParent(hwnd)
    if not parent:
        raise ValueError('UNSUPPORTED_CONTROL: selection requires an observed parent window')
    control_id = winio.user32.GetDlgCtrlID(hwnd)
    winio._send_timeout(parent, 0x0111, ((notification & 0xffff) << 16) | (control_id & 0xffff), hwnd)


def run(hwnd, action, value=None):
    """check/uncheck; select(index); scroll(signed lines). Returns readback evidence.

    Selection fires the standard parent change notification. Checkbox clicks are
    sent only if its two-state value differs, preserving normal app events.
    Scroll is supported for multiline Edit and single-selection ListBox only.
    """
    kind = _kind(hwnd)
    style = winio.user32.GetWindowLongW(hwnd, -16) & 0xffffffff
    if not winio.user32.IsWindowEnabled(hwnd):
        raise ValueError('CONTROL_DISABLED: do not mutate a disabled control')
    send = winio._send_timeout
    if action == 'replace_text':
        if kind not in {'EDIT', 'RICHEDIT'} or style & 0x0800:
            raise ValueError('UNSUPPORTED_CONTROL: replace_text requires a writable Edit or RichEdit')
        if not isinstance(value, str) or '\0' in value or len(value) > 100000:
            raise ValueError('INVALID_TEXT: maximum 100000 characters without NUL')
        before = winio._get_window_text(hwnd)
        if before != value:
            # Normal undoable editing emits change notifications; WM_SETTEXT on
            # multiline editors does not. Never forge parent notifications.
            buf = ctypes.create_unicode_buffer(value)
            send(hwnd, 0x00B1, 0, -1)  # EM_SETSEL: select document
            send(hwnd, 0x00C2, 1, ctypes.addressof(buf))  # EM_REPLACESEL
        result = _result(hwnd, before, winio._get_window_text(hwnd), value, 'control text; application save is not verified')
        result['application_commit'] = 'not_verified'
        return result
    if action in {'check', 'uncheck'}:
        if kind != 'BUTTON' or style & 0xf not in {2, 3, 5, 6}:
            raise ValueError(f'UNSUPPORTED_CONTROL: check/uncheck requires a standard checkbox (class={kind}, style={style & 0xf})')
        if value is not None:
            raise ValueError('INVALID_ARGUMENT: check/uncheck does not accept a value')
        expected = int(action == 'check')
        before = send(hwnd, 0x00F0, 0, 0)  # BM_GETCHECK
        if before not in {0, 1}:
            raise ValueError('UNSUPPORTED_CONTROL: indeterminate checkbox requires explicit application-specific handling')
        if before != expected:
            send(hwnd, 0x00F5, 0, 0)  # BM_CLICK, normal application notifications
        after = send(hwnd, 0x00F0, 0, 0)
        return _result(hwnd, before, after, expected, 'checkbox state; business effects require separate verification')
    if action == 'select':
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100000:
            raise ValueError('INVALID_ARGUMENT: select requires a nonnegative integer index <=100000')
        if kind == 'COMBOBOX':
            count_msg, get_msg, set_msg = 0x0146, 0x0147, 0x014E
        elif kind == 'LISTBOX' and not style & (0x0008 | 0x0800 | 0x4000):
            count_msg, get_msg, set_msg = 0x018B, 0x0188, 0x0186
        else:
            raise ValueError('UNSUPPORTED_CONTROL: select requires ComboBox or single-selection ListBox')
        # Check parent before changing anything.
        if not winio.user32.GetParent(hwnd):
            raise ValueError('UNSUPPORTED_CONTROL: control has no parent for notifications')
        count = send(hwnd, count_msg, 0, 0)
        if count > 100000 or value >= count:
            raise ValueError('INVALID_INDEX: selection is outside the observed item count')
        before = send(hwnd, get_msg, 0, 0)
        if before != value:
            result = send(hwnd, set_msg, value, 0)
            if result != value:
                raise RuntimeError('SELECTION_FAILED: control did not accept index; inspect before retrying')
            _notify(hwnd, 1)  # CBN_SELCHANGE or LBN_SELCHANGE
        after = send(hwnd, get_msg, 0, 0)
        return _result(hwnd, before, after, value, 'selected index and parent change notification')
    if action == 'scroll':
        if isinstance(value, bool) or not isinstance(value, int) or not -100 <= value <= 100 or value == 0:
            raise ValueError('INVALID_ARGUMENT: scroll requires signed lines -100..100 excluding zero')
        if kind == 'EDIT' and style & 0x0004:  # ES_MULTILINE
            before = send(hwnd, 0x00CE, 0, 0)  # EM_GETFIRSTVISIBLELINE
            send(hwnd, 0x00B6, 0, value)  # EM_LINESCROLL
            after = send(hwnd, 0x00CE, 0, 0)
            return {'target_hwnd': hwnd, 'status': 'observed', 'verified': False, 'retry_safe': False,
                    'before': before, 'after': after, 'changed': before != after,
                    'verification_scope': 'first visible line observed; viewport may clamp at boundary'}
        if kind == 'LISTBOX' and not style & (0x0008 | 0x0800 | 0x4000 | 0x0200):
            count = send(hwnd, 0x018B, 0, 0)
            if count <= 0 or count > 100000:
                raise ValueError('UNSUPPORTED_CONTROL: list must have 1..100000 items')
            before = send(hwnd, 0x018E, 0, 0)  # LB_GETTOPINDEX
            expected = max(0, min(count-1, before+value))
            send(hwnd, 0x0197, expected, 0)  # LB_SETTOPINDEX
            after = send(hwnd, 0x018E, 0, 0)
            return {'target_hwnd': hwnd, 'status': 'observed', 'verified': False, 'retry_safe': False,
                    'before': before, 'after': after, 'changed': before != after,
                    'verification_scope': 'top index observed; viewport may clamp at boundary'}
        raise ValueError('UNSUPPORTED_CONTROL: scroll requires multiline Edit or standard single-selection ListBox')
    raise ValueError('INVALID_ARGUMENT: supported actions are check, uncheck, select, scroll')
