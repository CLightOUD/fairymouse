"""Test-only Windows MCP resource baseline; stdlib, no user applications or input.

CPU is percent of one logical core (100% = one busy core). Summed working sets
can count shared pages more than once; private bytes are committed private
memory, not a promise about physical RAM. The sampler itself is excluded.
"""
import argparse
import ctypes
from ctypes import wintypes as W
import datetime
import json
import os
from pathlib import Path
import queue
import shutil
import statistics
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
K = ctypes.WinDLL('kernel32', use_last_error=True)
P = ctypes.WinDLL('psapi', use_last_error=True)
SYNCHRONIZE = 0x100000
QUERY = 0x1000


class ProcessEntry(ctypes.Structure):
    _fields_ = [('size', W.DWORD), ('usage', W.DWORD), ('pid', W.DWORD),
                ('heap', ctypes.c_size_t), ('module', W.DWORD), ('threads', W.DWORD),
                ('parent', W.DWORD), ('priority', W.LONG), ('flags', W.DWORD),
                ('exe', W.WCHAR * 260)]


class MemoryCounters(ctypes.Structure):
    _fields_ = [('cb', W.DWORD), ('faults', W.DWORD)] + [
        (name, ctypes.c_size_t) for name in ('peakWorkingSet', 'workingSet',
        'peakPagedPool', 'pagedPool', 'peakNonpagedPool', 'nonpagedPool',
        'pagefile', 'peakPagefile', 'privateBytes')]


K.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
K.OpenProcess.restype = W.HANDLE
K.CloseHandle.argtypes = [W.HANDLE]
K.CloseHandle.restype = W.BOOL
K.CreateToolhelp32Snapshot.argtypes = [W.DWORD, W.DWORD]
K.CreateToolhelp32Snapshot.restype = W.HANDLE
K.Process32FirstW.argtypes = [W.HANDLE, ctypes.POINTER(ProcessEntry)]
K.Process32NextW.argtypes = [W.HANDLE, ctypes.POINTER(ProcessEntry)]
K.GetProcessTimes.argtypes = [W.HANDLE] + [ctypes.POINTER(W.FILETIME)] * 4
K.GetProcessTimes.restype = W.BOOL
K.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]
K.WaitForSingleObject.restype = W.DWORD
K.GetProcessHandleCount.argtypes = [W.HANDLE, ctypes.POINTER(W.DWORD)]
K.GetProcessHandleCount.restype = W.BOOL
K.GetCurrentProcess.restype = W.HANDLE
K.QueryFullProcessImageNameW.argtypes = [W.HANDLE, W.DWORD, W.LPWSTR, ctypes.POINTER(W.DWORD)]
K.QueryFullProcessImageNameW.restype = W.BOOL
P.GetProcessMemoryInfo.argtypes = [W.HANDLE, ctypes.POINTER(MemoryCounters), W.DWORD]
P.GetProcessMemoryInfo.restype = W.BOOL


def ticks(value):
    return (value.dwHighDateTime << 32) | value.dwLowDateTime


def times(handle):
    created, exited, kernel, user = (W.FILETIME() for _ in range(4))
    if not K.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                             ctypes.byref(kernel), ctypes.byref(user)):
        raise ctypes.WinError(ctypes.get_last_error())
    return ticks(created), (ticks(kernel) + ticks(user)) / 10_000_000


def process_rows():
    handle = K.CreateToolhelp32Snapshot(2, 0)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        entry = ProcessEntry()
        entry.size = ctypes.sizeof(entry)
        ok = K.Process32FirstW(handle, ctypes.byref(entry))
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())
        rows = []
        while ok:
            rows.append((entry.pid, entry.parent, entry.exe))
            ok = K.Process32NextW(handle, ctypes.byref(entry))
        if ctypes.get_last_error() not in (0, 18):
            raise ctypes.WinError(ctypes.get_last_error())
        return rows
    finally:
        K.CloseHandle(handle)


def handle_count(handle):
    count = W.DWORD()
    if not K.GetProcessHandleCount(handle, ctypes.byref(count)):
        raise ctypes.WinError(ctypes.get_last_error())
    return count.value


def eligible_child(parent_created, child_created):
    """Creation ordering prevents a reused parent PID adopting older processes."""
    return child_created >= parent_created


def cpu_percent(first, last, seconds):
    if seconds <= 0 or last < first:
        raise ValueError('CPU interval must have positive time and monotonic CPU')
    return (last - first) / seconds * 100


class Tracker:
    def __init__(self):
        self.items = {}
        self.roots = set()
        self.discovery_misses = 0
        self.discovery_failures = []

    def register(self, pid, parent=None, root=False):
        handle = K.OpenProcess(QUERY | SYNCHRONIZE | 0x10, False, pid)
        if not handle:
            # A discovered child can exit before OpenProcess. Preserve the gap.
            if root:
                raise ctypes.WinError(ctypes.get_last_error())
            self.discovery_misses += 1
            if len(self.discovery_failures) < 32:
                self.discovery_failures.append({'pid': pid, 'parent': parent,
                    'stage': 'OpenProcess', 'win32Error': ctypes.get_last_error()})
            return False
        try:
            created, _ = times(handle)
            key = (pid, created)
            if key in self.items:
                return False
            if parent is not None and not eligible_child(parent[1], created):
                return False
            image = ctypes.create_unicode_buffer(32768)
            length = W.DWORD(len(image))
            if not K.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(length)):
                raise ctypes.WinError(ctypes.get_last_error())
            self.items[key] = {'handle': handle, 'parent': parent, 'image': Path(image.value).name}
            if root:
                self.roots.add(key)
            handle = None
            return True
        finally:
            if handle:
                K.CloseHandle(handle)

    def scan(self):
        rows = process_rows()
        for _ in range(12):
            # Retained handles keep even exited process IDs from being reused.
            # A stale snapshot row is not a new child; exited parents can still
            # have living descendants that we have not discovered yet.
            known = {key[0]: key for key in self.items}
            added = False
            for pid, ppid, _ in rows:
                if pid not in known and ppid in known:
                    added = self.register(pid, known[ppid]) or added
            if not added:
                return
        raise RuntimeError('Unexpected process-tree depth')

    def sample(self):
        self.scan()
        working = private = handles = alive = 0
        composition = {}
        cpu = 0.0
        for key, item in self.items.items():
            h = item['handle']
            created, consumed = times(h)
            if created != key[1]:
                raise RuntimeError('Retained process handle identity changed')
            cpu += consumed
            state = K.WaitForSingleObject(h, 0)
            if state == 0:
                continue
            if state != 258:
                raise RuntimeError('Process wait state unavailable')
            mem = MemoryCounters()
            mem.cb = ctypes.sizeof(mem)
            if not P.GetProcessMemoryInfo(h, ctypes.byref(mem), mem.cb):
                # An exact retained process may finish between wait and query.
                if K.WaitForSingleObject(h, 0) == 0:
                    continue
                raise ctypes.WinError(ctypes.get_last_error())
            working += mem.workingSet
            private += mem.privateBytes
            handles += handle_count(h)
            alive += 1
            composition[item['image']] = composition.get(item['image'], 0) + 1
        return {'at': time.perf_counter(), 'cpuSeconds': cpu,
                'workingSetBytesSum': working, 'privateBytesSum': private,
                'handleCountSum': handles, 'aliveProcesses': alive,
                'processImageCounts': composition}

    def close(self):
        errors = []
        for key, item in list(self.items.items()):
            try:
                if not K.CloseHandle(item['handle']):
                    raise ctypes.WinError(ctypes.get_last_error())
                del self.items[key]
            except Exception as error:
                errors.append(str(error))
        if errors:
            raise RuntimeError('Process handle cleanup incomplete: ' + '; '.join(errors))

    def exit_states(self):
        """Exit evidence independent of memory/CPU query availability."""
        alive, unknown = 0, 0
        for item in self.items.values():
            state = K.WaitForSingleObject(item['handle'], 0)
            if state == 258:
                alive += 1
            elif state != 0:
                unknown += 1
        return alive, unknown


class Client:
    def __init__(self, route, tracker):
        self.route = route
        self.tracker = tracker
        self.started = time.perf_counter()
        entry = 'desktop/background-mcp.mjs' if route == 'desktop' else 'hidden/launch.mjs'
        self.process = subprocess.Popen([shutil.which('node'), str(ROOT / entry)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW,
            cwd=ROOT, env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1'})
        self.responses = queue.Queue()
        self.errors = []
        self.sequence = 0
        try:
            self.tracker.register(self.process.pid, root=True)
        except Exception:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()  # Only this directly spawned root, never an unobserved tree.
            raise
        self.readers = [threading.Thread(target=self._read, daemon=True),
                        threading.Thread(target=self._errors, daemon=True)]
        for reader in self.readers:
            reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                self.responses.put(json.loads(line))
        except Exception as error:
            self.responses.put(error)
        finally:
            self.responses.put(RuntimeError('MCP closed before response'))

    def _errors(self):
        for line in self.process.stderr:
            if len(self.errors) < 20:
                self.errors.append(line.strip())

    def rpc(self, method, params=None):
        self.sequence += 1
        ident = self.sequence
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': ident,
            'method': method, 'params': params or {}}) + '\n')
        self.process.stdin.flush()
        deadline = time.perf_counter() + 15
        while time.perf_counter() < deadline:
            self.tracker.scan()
            try:
                result = self.responses.get(timeout=.05)
            except queue.Empty:
                continue
            if isinstance(result, Exception):
                raise result
            if 'id' not in result:  # MCP notification, not a request response.
                continue
            if result['id'] != ident:
                raise RuntimeError('Unexpected MCP response ID')
            if 'error' in result:
                raise RuntimeError(str(result['error']))
            return result['result']
        raise TimeoutError('MCP response deadline; no action replayed')

    def initialize(self):
        self.rpc('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {},
            'clientInfo': {'name': 'resource-baseline-test', 'version': '1'}})
        self.process.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        self.process.stdin.flush()
        tools = self.rpc('tools/list')['tools']
        self.ready_ms = (time.perf_counter() - self.started) * 1000
        return len(tools)

    def call(self, tool, arguments=None):
        value = self.rpc('tools/call', {'name': tool, 'arguments': arguments or {}})
        if value.get('isError'):
            raise RuntimeError(tool + ': ' + str(value.get('structuredContent')))
        return value.get('structuredContent', {})

    def shutdown(self):
        if not self.process.stdin.closed:
            self.process.stdin.close()

    def dispose(self):
        errors = []
        try:
            for reader, stream in zip(self.readers, (self.process.stdout, self.process.stderr)):
                reader.join(.5)
                if reader.is_alive():
                    errors.append('MCP output reader has not exited; pipe may be inherited by an unobserved child')
                else:
                    try:
                        stream.close()
                    except Exception as error:
                        errors.append(str(error))
        finally:
            # Popen retains its own Windows handle until its object is reclaimed.
            if self.process.poll() is not None:
                self.process._handle.Close()
        if errors:
            raise RuntimeError('; '.join(errors))


def cleanup_scenario(tracker, clients, desktops, result):
    """Always send EOF and release measurement handles, even if statistics fail."""
    errors = result.setdefault('cleanupErrors', [])
    before = after = None
    alive = unknown = None
    started = time.perf_counter()
    try:
        try:
            for client, name in desktops:
                try:
                    client.call('hidden_release', {'name': name})
                except Exception as error:
                    errors.append('desktop release: ' + str(error))
            try:
                before = tracker.sample()
            except Exception as error:
                errors.append('pre-shutdown measurement: ' + str(error))
        finally:
            # This must run even when process enumeration or accounting fails.
            for client in clients:
                try:
                    client.shutdown()
                except Exception as error:
                    errors.append('stdin close: ' + str(error))
        deadline = time.perf_counter() + 8
        scan_failed = wait_failed = False
        while time.perf_counter() < deadline:
            if not scan_failed:
                try:
                    tracker.scan()
                except Exception as error:
                    errors.append('cleanup process discovery: ' + str(error))
                    scan_failed = True
            try:
                alive, unknown = tracker.exit_states()
            except Exception as error:
                if not wait_failed:
                    errors.append('cleanup process waits: ' + str(error))
                    wait_failed = True
                alive = unknown = None
            roots_done = all(client.process.poll() is not None for client in clients)
            if roots_done and alive == 0 and unknown == 0:
                break
            time.sleep(.05)
        try:
            after = tracker.sample()
        except Exception as error:
            errors.append('post-shutdown measurement: ' + str(error))
    except Exception as error:
        errors.append('cleanup: ' + str(error))
    finally:
        # Stream/handle disposal is independent per client and independent of
        # sampler success. No unknown descendant is terminated as a fallback.
        for client in clients:
            if client.process.poll() is not None:
                try:
                    client.dispose()
                except Exception as error:
                    errors.append('client disposal: ' + str(error))
        result['shutdownMs'] = round((time.perf_counter()-started)*1000, 2)
        result['cleanup'] = {'observedProcessIdentities': len(tracker.items),
            'aliveBeforeShutdown': before['aliveProcesses'] if before else None,
            'aliveAfterShutdown': alive, 'unknownExitStates': unknown,
            'handlesBeforeShutdown': before['handleCountSum'] if before else None,
            'handlesAfterShutdown': after['handleCountSum'] if after else None,
            'discoveryMisses': tracker.discovery_misses,
            'discoveryFailures': tracker.discovery_failures,
            'rootExitCodes': [client.process.poll() for client in clients]}
        try:
            tracker.close()
        except Exception as error:
            errors.append('measurement handle disposal: ' + str(error))
        if (errors or alive != 0 or unknown != 0 or tracker.discovery_misses
                or any(client.process.poll() != 0 for client in clients)):
            result['status'] = 'failed'
            result.setdefault('error', 'Incomplete measurement or cleanup; no unknown process was killed')
        if not errors:
            result.pop('cleanupErrors', None)


def idle_phase(tracker, duration):
    samples = [tracker.sample()]
    end = samples[0]['at'] + duration
    while time.perf_counter() < end:
        time.sleep(min(.2, max(0, end-time.perf_counter())))
        samples.append(tracker.sample())
    first, last = samples[0], samples[-1]
    seconds = last['at'] - first['at']
    return {'durationSeconds': round(seconds, 3), 'samples': len(samples),
        'cpuPercentOneCore': round(cpu_percent(first['cpuSeconds'], last['cpuSeconds'], seconds), 3),
        'workingSetMiBSumMedian': round(statistics.median(s['workingSetBytesSum'] for s in samples)/2**20, 3),
        'workingSetMiBSumPeak': round(max(s['workingSetBytesSum'] for s in samples)/2**20, 3),
        'privateMiBSumMedian': round(statistics.median(s['privateBytesSum'] for s in samples)/2**20, 3),
        'privateMiBSumPeak': round(max(s['privateBytesSum'] for s in samples)/2**20, 3),
        'handleCountFirst': first['handleCountSum'], 'handleCountLast': last['handleCountSum'],
        'aliveProcessCountFirst': first['aliveProcesses'], 'aliveProcessCountLast': last['aliveProcesses'],
        'processImageCountsLast': last['processImageCounts']}


def scenario(route, count, seconds):
    tracker = Tracker()
    clients = []
    desktops = []
    result = {'route': route, 'agents': count, 'status': 'failed'}
    try:
        for _ in range(count):
            client = Client(route, tracker)
            clients.append(client)
            expected = 26 if route == 'desktop' else 17
            if client.initialize() != expected:
                raise RuntimeError('Unexpected tool count')
            client.call('desktop_status' if route == 'desktop' else 'hidden_status')
        result['startupToToolsReadyMs'] = [round(c.ready_ms, 2) for c in clients]
        result['startupMethod'] = 'Each service launched and initialized sequentially; all agents then measured concurrently.'
        result['readyIdle'] = idle_phase(tracker, seconds)
        if route == 'hidden':
            activation = []
            for index, client in enumerate(clients):
                name = f'FairyHidden-resource-{os.getpid()}-{count}-{index}'
                desktops.append((client, name))
                start = time.perf_counter()
                client.call('hidden_create', {'name': name})
                activation.append(round((time.perf_counter()-start)*1000, 2))
                if client.call('hidden_windows', {'name': name}).get('result') != []:
                    raise RuntimeError('Resource desktop must remain empty')
            result['firstWorkerCreateMs'] = activation
            result['workerIdle'] = idle_phase(tracker, seconds)
            for client, name in desktops:
                value = client.call('hidden_release', {'name': name})
                if value.get('closed') is not True:
                    raise RuntimeError('Empty desktop release not confirmed')
            desktops.clear()
            result['desktopsReleased'] = count
            result['afterRelease'] = tracker.sample()
            result['afterRelease'].pop('at')
        result['status'] = 'passed'
    except Exception as error:
        result['error'] = str(error)
    finally:
        cleanup_scenario(tracker, clients, desktops, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--idle-seconds', type=float, default=3)
    parser.add_argument('--output', type=Path, default=ROOT/'reports/resource-usage.json')
    args = parser.parse_args()
    if not .5 <= args.idle_seconds <= 10:
        parser.error('--idle-seconds must be between 0.5 and 10')
    if not shutil.which('node'):
        parser.error('Node.js must be on PATH')
    before = handle_count(K.GetCurrentProcess())
    started = time.perf_counter()
    report = {'validatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'status': 'failed', 'runtimeDependenciesAdded': 0,
        'scope': 'Windows MCP process trees only; sampler and user applications excluded. Empty hidden desktops, no application launch, physical input or focus actions.',
        'definitions': {'cpuPercentOneCore': '100% means one logical core fully occupied; measured delta kernel+user CPU over actual wall interval.',
            'workingSetMiBSum': 'Sum of per-process resident working sets; shared pages may be counted repeatedly, not unique physical RAM.',
            'privateMiBSum': 'Sum of private committed memory, not resident physical memory.',
            'startup': 'Node process spawn through MCP initialize and tools/list. Repeated same-machine launches may use OS caches.',
            'coverage': 'PID and creation-time identities retain open handles. Live descendant scan every sample and while RPC waits; extremely short-lived unobserved processes may be missed.',
            'thresholds': 'No machine-independent CPU/RAM thresholds; protocol, measurement availability and observed-process cleanup are asserted.'},
        'environment': {'python': sys.version.split()[0], 'logicalProcessors': os.cpu_count()},
        'scenarios': []}
    try:
        for route, count in [('desktop',1), ('desktop',3), ('hidden',1), ('hidden',3)]:
            value = scenario(route, count, args.idle_seconds)
            report['scenarios'].append(value)
            if value['status'] != 'passed':
                break
        report['status'] = 'passed' if len(report['scenarios']) == 4 and all(s['status']=='passed' for s in report['scenarios']) else 'failed'
    except Exception as error:
        report['error'] = str(error)
    finally:
        report['elapsedSeconds'] = round(time.perf_counter()-started, 3)
        report['samplerHandles'] = {'before': before, 'after': handle_count(K.GetCurrentProcess()),
                                    'scope': 'Diagnostic only; Python I/O and thread startup may retain handles, excluded from service metrics.'}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
        print(json.dumps({'status': report['status'], 'report': str(args.output),
                          'elapsedSeconds': report['elapsedSeconds'],
                          'scenarios': [{key:s[key] for key in ('route','agents','status','error','cleanupErrors') if key in s} for s in report['scenarios']]}))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
