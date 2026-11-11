"""Opt-in hidden-desktop UIA via the existing patched native CLI.

No shell, physical input, arbitrary flags, or extra package dependencies. A
kill-on-close job contains only the short-lived CLI helper and its descendants.
"""
import atexit
from collections import OrderedDict
import ctypes
from ctypes import wintypes
import json
import msvcrt
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from vendor import winio

ROOT = Path(__file__).resolve().parents[1]
_scopes = OrderedDict()
_root = None


def configure_root(path):
    """Use the supervisor-owned worker directory; native state stays private."""
    global _root
    root=Path(path)
    resolved=root.resolve()
    if (root.is_symlink() or root.is_junction() or not root.is_dir()
            or resolved.parent != Path(tempfile.gettempdir()).resolve()
            or not resolved.name.startswith('fairymouse-semantic-worker-')):
        raise ValueError('INVALID_CACHE_ROOT: expected a supervisor-owned worker temporary directory')
    reset()
    _root=resolved


class BASIC_LIMIT(ctypes.Structure):
    _fields_ = [('PerProcessUserTimeLimit', ctypes.c_int64), ('PerJobUserTimeLimit', ctypes.c_int64),
                ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in ('ReadOperationCount','WriteOperationCount','OtherOperationCount',
                                                  'ReadTransferCount','WriteTransferCount','OtherTransferCount')]


class EXTENDED_LIMIT(ctypes.Structure):
    _fields_ = [('BasicLimitInformation', BASIC_LIMIT), ('IoInfo', IO_COUNTERS),
                ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]


k = winio.kernel32
k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
k.CreateJobObjectW.restype = wintypes.HANDLE
k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
k.SetInformationJobObject.restype = wintypes.BOOL
k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
k.AssignProcessToJobObject.restype = wintypes.BOOL
k.ResumeThread.argtypes = [wintypes.HANDLE]
k.ResumeThread.restype = wintypes.DWORD
k.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
k.TerminateProcess.restype = wintypes.BOOL


def reset(name=None):
    """Invalidate this worker's semantic state; never close or kill app windows."""
    for scope in list(_scopes):
        if name is None or scope[0] == name.casefold():
            shutil.rmtree(_scopes.pop(scope)['folder'], ignore_errors=True)


atexit.register(reset)


def invalidate(name):
    """Consume refs after any other route mutates this desktop; keep private state."""
    for (desktop, _), item in _scopes.items():
        if desktop == name.casefold():
            item['refs'] = set()


def _validate(name, hwnd):
    if not re.fullmatch(r'FairyHidden-[A-Za-z0-9_-]{1,48}', name, re.I) or not isinstance(hwnd,int) or hwnd <= 0:
        raise ValueError('INVALID_ARGUMENT: named hidden desktop and positive HWND required')
    desktop = winio.user32.OpenDesktopW(name, 0, False, winio.GENERIC_ALL)
    winio._check(desktop, 'OpenDesktopW existing semantic scope')
    matches=[]
    @winio.WNDENUMPROC
    def collect(handle, unused):
        if int(handle)==hwnd:
            matches.append(hwnd)
        return True
    try:
        winio.user32.EnumDesktopWindows(desktop, collect, 0)
        if not matches:
            raise ValueError('WRONG_DESKTOP_OR_STALE_WINDOW: semantic target must be a top-level hidden window')
    finally:
        winio.user32.CloseDesktop(desktop)


def _refs(value):
    found=set()
    if isinstance(value,dict):
        if isinstance(value.get('ref_id'),str):
            found.add(value['ref_id'])
        for child in value.values():
            found.update(_refs(child))
    elif isinstance(value,list):
        for child in value:
            found.update(_refs(child))
    return found


def _execute(name, folder, arguments, stdin_text=None):
    exe=ROOT/'desktop'/'agent-desktop.exe'
    state=folder/'state'  # CLI must create its own private ACL, never mkdir here.
    env={key:value for key,value in os.environ.items() if not key.upper().startswith('AGENT_DESKTOP_')}
    env['AGENT_DESKTOP_HOME']=str(state)
    block=ctypes.create_unicode_buffer('\0'.join(key+'='+value for key,value in sorted(env.items(),key=lambda x:x[0].casefold()))+'\0\0')
    job=winio._check(k.CreateJobObjectW(None,None),'CreateJobObjectW semantic helper')
    pi=winio.PROCESS_INFORMATION()
    limits=EXTENDED_LIMIT()
    limits.BasicLimitInformation.LimitFlags=0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    files=[folder/'stdin.txt',folder/'stdout.json',folder/'stderr.txt']
    try:
        winio._check(k.SetInformationJobObject(job,9,ctypes.byref(limits),ctypes.sizeof(limits)),'SetInformationJobObject')
        files[0].write_text(stdin_text or '',encoding='utf-8')
        with open(files[0],'rb') as inp, open(files[1],'wb') as out, open(files[2],'wb') as err:
            handles=[msvcrt.get_osfhandle(f.fileno()) for f in (inp,out,err)]
            for handle in handles:
                os.set_handle_inheritable(handle,True)
            si=winio.STARTUPINFO()
            si.cb=ctypes.sizeof(si)
            si.lpDesktop='WinSta0\\'+name
            si.dwFlags=0x100|1
            si.wShowWindow=0
            si.hStdInput,si.hStdOutput,si.hStdError=handles
            cmd=ctypes.create_unicode_buffer(subprocess.list2cmdline([str(exe),*arguments]))
            try:
                winio._check(k.CreateProcessW(str(exe),cmd,None,None,True,0x08000000|0x400|0x4,block,str(ROOT),ctypes.byref(si),ctypes.byref(pi)),'CreateProcessW semantic helper')
            finally:
                for handle in handles:
                    os.set_handle_inheritable(handle,False)
            if not k.AssignProcessToJobObject(job,pi.hProcess):
                k.TerminateProcess(pi.hProcess,125)
                raise RuntimeError('HELPER_ISOLATION_FAILED: helper was not allowed to run')
            if k.ResumeThread(pi.hThread)==0xffffffff:
                raise RuntimeError('HELPER_START_FAILED: helper did not resume')
            wait=k.WaitForSingleObject(pi.hProcess,8000)
            if wait==258:
                raise TimeoutError('TIMEOUT_UNKNOWN_OUTCOME: semantic helper timed out; no replay; observe application')
            if wait!=0:
                raise RuntimeError('HELPER_WAIT_FAILED: inspect application state')
        if files[1].stat().st_size>2_000_000:
            raise RuntimeError('OBSERVATION_TOO_LARGE: semantic output exceeds 2 MB')
        try:
            result=json.loads(files[1].read_text(encoding='utf-8'))
        except (ValueError,UnicodeError):
            raise RuntimeError('INVALID_HELPER_OUTPUT: native CLI returned no valid JSON')
        if not isinstance(result,dict):
            raise RuntimeError('INVALID_HELPER_OUTPUT: native CLI returned non-object JSON')
        return result
    finally:
        # Closing this job terminates only our helper tree, including on worker death.
        k.CloseHandle(job)
        if pi.hThread:
            k.CloseHandle(pi.hThread)
        if pi.hProcess:
            k.WaitForSingleObject(pi.hProcess,1000)
            k.CloseHandle(pi.hProcess)
        for path in files:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass


def run(name, hwnd, action='snapshot', ref=None, value=None, surface='window'):
    """Read a hidden UIA tree or perform one whitelisted semantic action.

    surface window/menu is only for snapshots. Action refs must come from this
    worker's snapshot of the exact name/HWND and expire after 60 seconds.
    """
    name=name.casefold()
    if action not in {'snapshot','click','expand','collapse','set_value'}:
        raise ValueError('INVALID_ARGUMENT: unsupported semantic action')
    if surface not in {'window','menu'}:
        raise ValueError('INVALID_ARGUMENT: only window/menu surfaces are allowed')
    if action=='snapshot' and (ref is not None or value is not None):
        raise ValueError('INVALID_ARGUMENT: snapshot does not accept ref/value')
    if action!='snapshot' and surface!='window':
        raise ValueError('INVALID_ARGUMENT: surface is only accepted for snapshots')
    if action=='set_value' and (not isinstance(value,str) or '\0' in value or len(value.encode('utf-8'))>131072):
        raise ValueError('INVALID_ARGUMENT: set_value requires UTF-8 text <=128 KiB without NUL')
    if action not in {'snapshot','set_value'} and value is not None:
        raise ValueError('INVALID_ARGUMENT: action does not accept value')
    _validate(name,hwnd)
    scope=(name,hwnd)
    if action=='snapshot':
        if scope not in _scopes:
            if len(_scopes)>=16:
                old=next(iter(_scopes))
                shutil.rmtree(_scopes.pop(old)['folder'],ignore_errors=True)
            _scopes[scope]={'folder':Path(tempfile.mkdtemp(prefix='fairymouse-semantic-',dir=_root)), 'refs':set(), 'time':0}
        item=_scopes[scope]
        item['refs']=set()
        args=['snapshot','--window-id','w-'+str(hwnd),'--include-bounds','--max-depth','20','--compact',
              '--timeout-ms','5000','--surface',surface]
    else:
        item=_scopes.get(scope)
        if not item or ref not in item['refs'] or time.monotonic()-item['time']>60:
            raise ValueError('STALE_REF: take a new semantic snapshot of this exact window')
        # Consume refs across the desktop before any action, even if it times out.
        invalidate(name)
        args=[action.replace('_','-'),ref]
        if action=='set_value':
            args.append('--stdin')
    result=_execute(name,item['folder'],args,value)
    if action=='snapshot' and result.get('ok'):
        item.update(refs=_refs(result.get('data',{})),time=time.monotonic())
    return result
