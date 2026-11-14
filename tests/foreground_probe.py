"""Read-only test diagnostics for one non-atomic Windows foreground sample.

No input, hooks, focus, activation, desktop switching, or extra dependencies.
Failure reasons are retained; a later good sample never repairs an earlier gap.
"""
import argparse
from collections import Counter
import ctypes
from ctypes import wintypes as W
import datetime
import json
from pathlib import Path
import time


def input_desktop_changed(previous, current):
    """Unknown desktop is a coverage gap, not evidence of a desktop switch."""
    return bool(previous and current and current != previous)


def take_sample(api):
    """Use an explicit GUI thread, then detect foreground changes during reads."""
    started = time.perf_counter()
    reasons = []
    def record(code, error=None):
        reasons.append({'reason': code, 'win32Error': error})

    foreground = api.foreground()
    if not foreground:
        # GetForegroundWindow does not document GetLastError on NULL.
        record('FOREGROUND_NULL')
    thread, pid, error = api.window_thread(foreground) if foreground else (0, 0, None)
    if foreground and not thread:
        record('FOREGROUND_THREAD_UNAVAILABLE', error)
    cursor, error = api.cursor()
    if cursor is None:
        record('CURSOR_READ_FAILED', error)
    desk, desktop_errors = api.desktop()
    reasons.extend(desktop_errors)
    focus = 0
    if thread:
        focus, error = api.gui_thread(thread)
        if focus is None:
            record('GUI_THREAD_INFO_FAILED', error)
            focus = 0
    foreground_key = None
    if pid:
        foreground_key, stage, error = api.identity(pid)
        if not foreground_key:
            record('FOREGROUND_' + stage, error)
    focus_key = None
    if focus:
        focus_thread, focus_pid, error = api.window_thread(focus)
        if not focus_thread:
            record('FOCUS_THREAD_UNAVAILABLE', error)
        else:
            focus_key, stage, error = api.identity(focus_pid)
            if not focus_key:
                record('FOCUS_' + stage, error)
    after = api.foreground()
    if after != foreground:
        record('FOREGROUND_CHANGED_DURING_SAMPLE')
    return {'valid': not reasons, 'foreground': foreground, 'focus': focus,
            'cursor': cursor, 'desktop': desk, 'foregroundIdentity': foreground_key,
            'focusIdentity': focus_key, 'reasons': reasons,
            'sampleDurationMs': (time.perf_counter() - started) * 1000}


class WindowsProbe:
    def __init__(self):
        self.u = ctypes.WinDLL('user32', use_last_error=True)
        self.k = ctypes.WinDLL('kernel32', use_last_error=True)
        u, k = self.u, self.k
        class Info(ctypes.Structure):
            _fields_ = [('cbSize', W.DWORD), ('flags', W.DWORD),
                        *[(name, W.HWND) for name in ('hwndActive', 'hwndFocus', 'hwndCapture',
                          'hwndMenuOwner', 'hwndMoveSize', 'hwndCaret')], ('rcCaret', W.RECT)]
        self.Info = Info
        u.GetForegroundWindow.restype = W.HWND
        u.GetWindowThreadProcessId.argtypes = [W.HWND, ctypes.POINTER(W.DWORD)]
        u.GetWindowThreadProcessId.restype = W.DWORD
        u.GetCursorPos.argtypes = [ctypes.POINTER(W.POINT)]
        u.GetGUIThreadInfo.argtypes = [W.DWORD, ctypes.POINTER(Info)]
        u.OpenInputDesktop.argtypes = [W.DWORD, W.BOOL, W.DWORD]
        u.OpenInputDesktop.restype = W.HANDLE
        u.GetUserObjectInformationW.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                               W.DWORD, ctypes.POINTER(W.DWORD)]
        u.CloseDesktop.argtypes = [W.HANDLE]
        k.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
        k.OpenProcess.restype = W.HANDLE
        k.GetProcessTimes.argtypes = [W.HANDLE, *([ctypes.POINTER(W.FILETIME)] * 4)]
        k.CloseHandle.argtypes = [W.HANDLE]

    def foreground(self):
        return int(self.u.GetForegroundWindow() or 0)

    def window_thread(self, hwnd):
        pid = W.DWORD()
        ctypes.set_last_error(0)
        thread = self.u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return int(thread), pid.value, ctypes.get_last_error() if not thread else None

    def cursor(self):
        point = W.POINT()
        ctypes.set_last_error(0)
        ok = self.u.GetCursorPos(ctypes.byref(point))
        return ((point.x, point.y), None) if ok else (None, ctypes.get_last_error())

    def gui_thread(self, thread):
        info = self.Info()
        info.cbSize = ctypes.sizeof(info)
        ctypes.set_last_error(0)
        ok = self.u.GetGUIThreadInfo(thread, ctypes.byref(info))
        return (int(info.hwndFocus or 0), None) if ok else (None, ctypes.get_last_error())

    def desktop(self):
        ctypes.set_last_error(0)
        handle = self.u.OpenInputDesktop(0, False, 1)
        if not handle:
            return None, [{'reason': 'INPUT_DESKTOP_OPEN_FAILED', 'win32Error': ctypes.get_last_error()}]
        errors = []
        name = ctypes.create_unicode_buffer(256)
        needed = W.DWORD()
        ctypes.set_last_error(0)
        ok = self.u.GetUserObjectInformationW(handle, 2, name, ctypes.sizeof(name), ctypes.byref(needed))
        if not ok:
            errors.append({'reason': 'INPUT_DESKTOP_NAME_FAILED', 'win32Error': ctypes.get_last_error()})
        ctypes.set_last_error(0)
        if not self.u.CloseDesktop(handle):
            errors.append({'reason': 'INPUT_DESKTOP_CLOSE_FAILED', 'win32Error': ctypes.get_last_error()})
        return name.value if ok else None, errors

    def identity(self, pid):
        ctypes.set_last_error(0)
        handle = self.k.OpenProcess(0x1000, False, pid)
        if not handle:
            return None, 'PROCESS_OPEN_FAILED', ctypes.get_last_error()
        try:
            a, b, c, d = W.FILETIME(), W.FILETIME(), W.FILETIME(), W.FILETIME()
            ctypes.set_last_error(0)
            ok = self.k.GetProcessTimes(handle, ctypes.byref(a), ctypes.byref(b), ctypes.byref(c), ctypes.byref(d))
            if not ok:
                return None, 'PROCESS_TIMES_FAILED', ctypes.get_last_error()
            return str(pid) + ':' + str((a.dwHighDateTime << 32) | a.dwLowDateTime), None, None
        finally:
            self.k.CloseHandle(handle)

    def sample(self):
        return take_sample(self)


def diagnose(seconds):
    api = WindowsProbe()
    started, cpu_started = time.perf_counter(), time.process_time()
    last = started
    samples = invalid = changes = 0
    maximum_gap = maximum_duration = 0
    total_duration = 0
    previous = None
    counts = Counter()
    events = []
    while time.perf_counter() - started < seconds:
        now = time.perf_counter()
        maximum_gap = max(maximum_gap, (now - last) * 1000)
        last = now
        sample = api.sample()
        samples += 1
        invalid += not sample['valid']
        maximum_duration = max(maximum_duration, sample['sampleDurationMs'])
        total_duration += sample['sampleDurationMs']
        current = (sample['foreground'], sample['focus'], sample['cursor'], sample['desktop'])
        changes += previous is not None and current != previous
        previous = current
        for reason in sample['reasons']:
            counts[reason['reason']] += 1
        if sample['reasons'] and len(events) < 128:
            events.append({'elapsedMs': round((now - started) * 1000, 2), 'reasons': sample['reasons']})
        time.sleep(.02)
    elapsed = time.perf_counter() - started
    cpu = time.process_time() - cpu_started
    return {'validatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'mode': 'read_only_diagnostic', 'samples': samples, 'invalidSamples': invalid,
            'invalidReasonCounts': dict(counts), 'invalidEvents': events,
            'invalidEventsTruncated': invalid > len(events), 'activityChangeSamples': changes,
            'elapsedSeconds': round(elapsed, 3), 'probeCpuSeconds': round(cpu, 6),
            'probeCpuPercentOneCore': round(cpu / elapsed * 100, 3),
            'maximumSampleGapMs': round(maximum_gap, 3),
            'meanSampleDurationMs': round(total_duration / samples, 3),
            'maximumSampleDurationMs': round(maximum_duration, 3),
            'historicalInvalidSamples': {'edge': 4, 'notepad': 2,
              'cause': 'Not recoverable: historical reports did not retain per-API failures.'},
            'scope': 'No GUI actions; no process registration or no-interference verdict. '
                     'All invalid observations retained without retry or reclassification as valid.',
            'sources': ['https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow',
                        'https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getguithreadinfo']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=float, default=30)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 0 < args.seconds <= 120:
        parser.error('seconds must be greater than zero and no more than 120')
    result = diagnose(args.seconds)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))
