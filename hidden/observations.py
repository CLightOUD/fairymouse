"""Small process leases and bounded observations; no extra dependencies."""
import ctypes
import hashlib
import msvcrt
import os
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from ctypes import wintypes
from vendor import winio

_locks = {}
_snapshots = OrderedDict()
winio.kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
winio.kernel32.OpenProcess.restype = wintypes.HANDLE
winio.kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
winio.kernel32.GetProcessTimes.restype = wintypes.BOOL
winio.user32.GetParent.argtypes = [wintypes.HWND]
winio.user32.GetParent.restype = wintypes.HWND


def claim(name):
    name = name.casefold()
    if name in _locks:
        return
    folder = Path(os.environ['LOCALAPPDATA']) / 'Fairymouse' / 'leases'
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (hashlib.sha256(name.encode()).hexdigest() + '.lock')
    stream = open(path, 'a+b')
    try:
        if path.stat().st_size == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        stream.close()
        raise RuntimeError('DESKTOP_OWNED: another server owns this desktop; use a distinct name or wait for release')
    _locks[name] = stream


def release(name):
    name = name.casefold()
    for key in list(_snapshots):
        if _snapshots[key]['name'] == name:
            del _snapshots[key]
    stream = _locks.pop(name, None)
    if stream:
        stream.seek(0)
        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        stream.close()


def invalidate(name):
    for key in list(_snapshots):
        if _snapshots[key]['name'] == name:
            _snapshots[key]['consumed'] = True


def identity(hwnd):
    pid = wintypes.DWORD()
    tid = winio.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not tid:
        raise ValueError('STALE_REF: window disappeared')
    handle = winio.kernel32.OpenProcess(0x1000, False, pid.value)
    if not handle:
        raise ValueError('IDENTITY_UNAVAILABLE: cannot verify process creation time')
    stamps = [wintypes.FILETIME() for _ in range(4)]
    try:
        if not winio.kernel32.GetProcessTimes(handle, *(ctypes.byref(t) for t in stamps)):
            raise ValueError('IDENTITY_UNAVAILABLE: cannot read process creation time')
    finally:
        winio.kernel32.CloseHandle(handle)
    rect = wintypes.RECT()
    context = winio.user32.GetWindowDpiAwarenessContext(hwnd)
    previous = winio.user32.SetThreadDpiAwarenessContext(context) if context else None
    try:
        if not winio.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            raise ValueError('STALE_REF: window bounds unavailable')
    finally:
        if previous:
            winio.user32.SetThreadDpiAwarenessContext(previous)
    return [pid.value, tid, stamps[0].dwHighDateTime, stamps[0].dwLowDateTime,
            winio.user32.GetParent(hwnd), winio._get_class_name(hwnd),
            winio.user32.GetDlgCtrlID(hwnd), rect.left, rect.top, rect.right, rect.bottom,
            winio._get_window_text(hwnd)]


def remember(name, hwnd, rows):
    key = uuid.uuid4().hex
    entries = []
    for index, row in enumerate(rows):
        try:
            fingerprint = identity(row['handle'])
        except (ValueError, winio.WinIOError):
            entries.append({**row, 'ref': None})
            continue
        entries.append({**row, 'ref': key + ':' + str(index), '_identity': fingerprint})
    _snapshots[key] = {'name': name, 'hwnd': hwnd, 'time': time.monotonic(), 'entries': entries}
    while len(_snapshots) > 32:
        _snapshots.popitem(last=False)
    return key, entries


def snapshot(key, name, hwnd):
    item = _snapshots.get(key)
    if not item or item['name'] != name or item['hwnd'] != hwnd or time.monotonic()-item['time'] > 60:
        raise ValueError('STALE_SNAPSHOT: observe again; baseline expired or belongs to another scope')
    return item


def resolve(ref, name, check=True):
    try:
        key, index = ref.split(':')
        item = _snapshots[key]
        if item['name'] != name or item.get('consumed') or time.monotonic()-item['time'] > 60:
            raise KeyError()
        entry = item['entries'][int(index)]
        if entry['ref'] != ref:
            raise KeyError()
    except (ValueError, KeyError, IndexError):
        raise ValueError('STALE_REF: observe again; reference expired or belongs to another scope')
    if check and identity(entry['handle']) != entry['_identity']:
        raise ValueError('STALE_REF: target identity, geometry or text changed; observe again')
    return entry


def public(entry):
    return {key: value for key, value in entry.items() if key != '_identity'}


def difference(before, after):
    old = {e['handle']: public(e) for e in before}
    new = {e['handle']: public(e) for e in after}
    changed = []
    for hwnd in old.keys() & new.keys():
        fields = {k: v for k, v in new[hwnd].items() if k != 'ref' and old[hwnd].get(k) != v}
        old_entry = next(e for e in before if e['handle'] == hwnd)
        new_entry = next(e for e in after if e['handle'] == hwnd)
        if old_entry.get('_identity', [])[:7] != new_entry.get('_identity', [])[:7]:
            fields['identity_changed'] = True
        if fields:
            changed.append({'handle': hwnd, 'ref': new[hwnd]['ref'], 'fields': fields})
    return {'added': [new[h] for h in new.keys()-old.keys()], 'removed': list(old.keys()-new.keys()), 'changed': changed}
