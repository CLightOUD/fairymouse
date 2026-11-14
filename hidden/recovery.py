"""One lazy, disposable native worker. Supervisor retains leases and process handles."""
import atexit
import multiprocessing as mp
from multiprocessing.reduction import DupHandle
import time
import sys
import tempfile
import shutil
from pathlib import Path
from vendor import winio
import observations


def worker(connection, semantic_root):
    import server
    server.semantic.configure_root(semantic_root)
    # Ownership stays in the supervisor across worker replacement.
    observations.claim = lambda name: None
    known = set()
    try:
        while True:
            request = connection.recv()
            if request is None:
                return
            fn, args, restore = request
            for name, processes in restore.items():
                server._processes[name] = {pid: handle.detach() for pid, handle in processes.items()}
                known.update((name, pid) for pid in processes)
            try:
                if fn == '__test_block':
                    time.sleep(60)
                if fn in {'hidden_click','hidden_set_text','hidden_type_text','hidden_keys','hidden_close_window','hidden_launch'}:
                    observations.invalidate(args['name'])
                if fn in {'hidden_click','hidden_set_text','hidden_type_text','hidden_keys','hidden_close_window','hidden_launch','hidden_act'}:
                    server.semantic.invalidate(args['name'])
                value = getattr(server, fn)(**args)
                if fn == 'hidden_release':
                    server.semantic.reset(args['name'])
                    known = {item for item in known if item[0] != args['name']}
                error = None
            except Exception as exc:
                value, error = None, str(exc)
            transfers = {}
            for name, processes in server._processes.items():
                for pid, handle in processes.items():
                    if (name, pid) not in known:
                        transfers.setdefault(name, {})[pid] = DupHandle(handle, 0x100000)
                        known.add((name, pid))
            connection.send((value, error, transfers))
    except (EOFError, BrokenPipeError):
        pass
    finally:
        connection.close()


class NativeWorker:
    def __init__(self):
        self.process = self.connection = None
        self.processes = {}
        self.desktops = {}
        self.generation = 0
        self.last_recovery = None
        self.semantic_root = None
        atexit.register(self.close)

    def close(self):
        if self.process:
            if self.process.is_alive():
                self.process.terminate()  # Only our worker, never task applications.
            self.process.join(2)
            if self.process.is_alive():
                raise RuntimeError('RECOVERY_FAILED: native worker did not exit')
            self.process.close()
            self.process = None
        if self.connection:
            self.connection.close()
            self.connection = None
        if self.semantic_root is not None:
            _remove_semantic_root(self.semantic_root)
            self.semantic_root = None

    def reset(self, reason):
        self.close()
        self.generation += 1
        self.last_recovery = reason

    def call(self, fn, args, timeout=14):
        name = args.get('name')
        if name:
            observations.claim(name)
        restore = {}
        if self.process is None or not self.process.is_alive():
            self.close()
            # multiprocessing duplicates handles into its direct child. A venv
            # pythonw redirector can create another process, losing those handles.
            # Use the real windowless interpreter; spawn restores our sys.path,
            # including the locked venv packages, before importing the worker.
            windowless = Path(sys._base_executable).with_name('pythonw.exe')
            if not windowless.is_file():
                raise RuntimeError('RUNTIME_MISSING: pythonw.exe is required for a windowless worker')
            mp.set_executable(str(windowless))
            parent, child = mp.get_context('spawn').Pipe()
            self.semantic_root = Path(tempfile.mkdtemp(prefix='fairymouse-semantic-worker-'))
            self.process = mp.get_context('spawn').Process(target=worker, args=(child, str(self.semantic_root)), daemon=True)
            try:
                self.process.start()
            except Exception:
                self.process.close()
                self.process = None
                parent.close()
                child.close()
                _remove_semantic_root(self.semantic_root)
                self.semantic_root = None
                raise
            child.close()
            self.connection = parent
            restore = {n: {pid: DupHandle(h, 0x100000) for pid, h in items.items()}
                       for n, items in self.processes.items()}
        try:
            self.connection.send((fn, args, restore))
            if not self.connection.poll(timeout):
                self.reset('worker deadline exceeded')
                raise RuntimeError('WORKER_TIMEOUT_UNKNOWN_OUTCOME: worker recycled; observe again, never replay mutation')
            value, error, transfers = self.connection.recv()
            for n, items in transfers.items():
                self.processes.setdefault(n, {}).update({pid: h.detach() for pid, h in items.items()})
            if name and name not in self.desktops:
                handle = winio.user32.OpenDesktopW(name, 0, False, winio.GENERIC_ALL)
                if handle:
                    self.desktops[name] = handle
            if error:
                if error.startswith(('TIMEOUT_UNKNOWN_OUTCOME:', 'BUSY_UNKNOWN_OUTCOME:')):
                    self.reset(error)
                raise RuntimeError(error)
            if fn == 'hidden_release':
                handle = self.desktops.get(name)
                if handle:
                    winio._check(winio.user32.CloseDesktop(handle), 'CloseDesktop supervisor lease')
                    self.desktops.pop(name)
                for handle in self.processes.pop(name, {}).values():
                    winio.kernel32.CloseHandle(handle)
                observations.release(name)
            return value
        except (EOFError, BrokenPipeError, OSError) as exc:
            self.reset(str(exc))
            raise RuntimeError('WORKER_LOST_UNKNOWN_OUTCOME: observe again; request was not replayed') from exc


def _remove_semantic_root(path):
    """Delete only the exact temporary directory assigned to this worker.

    Called only after confirming the native worker has exited; its kill-on-close
    helper jobs then release their cache handles. Never enumerate other workers.
    """
    target=Path(path)
    resolved=target.resolve()
    if (target.is_symlink() or target.is_junction()
            or resolved.parent != Path(tempfile.gettempdir()).resolve()
            or not resolved.name.startswith('fairymouse-semantic-worker-')):
        raise RuntimeError('CACHE_CLEANUP_REFUSED: path is not a worker temporary root')
    if not target.exists():
        return
    for attempt in range(4):
        try:
            shutil.rmtree(resolved)
            return
        except OSError as exc:
            if attempt==3:
                raise RuntimeError('CACHE_CLEANUP_FAILED: worker exited but temporary cache could not be removed') from exc
            time.sleep(.1)
