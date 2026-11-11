"""Real disposable-worker timeout recovery without user applications."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'hidden'))
from recovery import NativeWorker, _remove_semantic_root
import recovery
import observations


class RecoveryTests(unittest.TestCase):
    def test_timeout_preserves_lease_and_service_recovers(self):
        name = 'fairyhidden-recover-' + str(os.getpid())
        native = NativeWorker()
        try:
            native.call('hidden_create', {'name': name})
            old_root=native.semantic_root
            (old_root/'sensitive.txt').write_text('private UI tree',encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'WORKER_TIMEOUT_UNKNOWN_OUTCOME'):
                native.call('__test_block', {}, timeout=.15)
            self.assertIn(name, observations._locks)
            self.assertEqual(native.generation, 1)
            self.assertFalse(old_root.exists())
            self.assertEqual(native.call('hidden_windows', {'name': name}), [])
            new_root=native.semantic_root
            self.assertNotEqual(old_root,new_root)
            native.call('hidden_release', {'name': name})
            self.assertNotIn(name, observations._locks)
        finally:
            native.close()
            observations.release(name)
        self.assertFalse(new_root.exists())

    def test_cleanup_refuses_unrelated_directory(self):
        with tempfile.TemporaryDirectory(prefix='unrelated-') as folder:
            sentinel=Path(folder)/'keep.txt'
            sentinel.write_text('keep',encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError,'CACHE_CLEANUP_REFUSED'):
                _remove_semantic_root(folder)
            self.assertEqual(sentinel.read_text(encoding='utf-8'),'keep')

    def test_failed_worker_exit_preserves_cache(self):
        native=NativeWorker()
        with tempfile.TemporaryDirectory(prefix='fairymouse-semantic-worker-') as folder:
            native.semantic_root=Path(folder)
            native.process=Mock()
            native.process.is_alive.return_value=True
            try:
                with patch('recovery._remove_semantic_root') as remove:
                    with self.assertRaisesRegex(RuntimeError,'RECOVERY_FAILED'):
                        native.close()
                    remove.assert_not_called()
                    self.assertEqual(native.semantic_root,Path(folder))
            finally:
                native.process=None
                native.semantic_root=None

    def test_failed_desktop_close_retains_lease_and_handle_for_retry(self):
        native=NativeWorker()
        native.process=Mock()
        native.process.is_alive.return_value=True
        native.connection=Mock()
        native.connection.poll.return_value=True
        native.connection.recv.return_value=({'released':True},None,{})
        name='fairyhidden-release-test'
        native.desktops[name]=123
        native.processes[name]={42:456}
        try:
            with patch('recovery.observations.claim'), \
                 patch('recovery.observations.release') as release, \
                 patch.object(recovery.winio.user32,'CloseDesktop',side_effect=[0,1]), \
                 patch.object(recovery.winio.kernel32,'CloseHandle',return_value=1) as close:
                with self.assertRaisesRegex(RuntimeError,'CloseDesktop supervisor lease'):
                    native.call('hidden_release',{'name':name})
                self.assertEqual(native.desktops[name],123)
                self.assertEqual(native.processes[name],{42:456})
                release.assert_not_called()
                close.assert_not_called()
                native.call('hidden_release',{'name':name})
                self.assertNotIn(name,native.desktops)
                self.assertNotIn(name,native.processes)
                release.assert_called_once_with(name)
                close.assert_called_once_with(456)
        finally:
            native.process=native.connection=None

    def test_recovery_keeps_original_process_identity(self):
        name = 'fairyhidden-process-' + str(os.getpid())
        native = NativeWorker()
        try:
            launched = native.call('hidden_launch', {'name': name, 'executable': sys.executable,
                'arguments': ['-c', 'import time; time.sleep(4)'], 'wait_ms': 0})
            native.reset('test recovery')
            result = native.call('hidden_wait', {'name': name, 'condition': 'process_exited',
                'process_id': launched['pid'], 'timeout_ms': 0})
            self.assertFalse(result['verified'])
            done = native.call('hidden_wait', {'name': name, 'condition': 'process_exited',
                'process_id': launched['pid'], 'timeout_ms': 6000})
            self.assertTrue(done['verified'])
            native.call('hidden_release', {'name': name})
        finally:
            native.close()
            observations.release(name)


if __name__ == '__main__':
    unittest.main()
