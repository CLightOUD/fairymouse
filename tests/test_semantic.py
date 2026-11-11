"""Semantic bridge contract tests; no UI or external process is started."""
import sys
import ctypes
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'hidden'))
import semantic


class SemanticTests(unittest.TestCase):
    def setUp(self):
        semantic.reset()
        self.validate=patch.object(semantic,'_validate')
        self.validate.start()
        self.addCleanup(self.validate.stop)
        self.addCleanup(semantic.reset)

    def snapshot(self,name='FairyHidden-test',hwnd=12):
        with patch.object(semantic,'_execute',return_value={'ok':True,'data':{'tree':{'ref_id':'@snap:e1','children':[{'ref_id':'@snap:e2'}]}}}):
            semantic.run(name,hwnd)

    def test_snapshot_uses_observed_hwnd_and_private_state(self):
        with patch.object(semantic,'_execute',return_value={'ok':True,'data':{}}) as execute:
            semantic.run('FairyHidden-test',12)
            args=execute.call_args.args[2]
            self.assertEqual(args[args.index('--window-id')+1],'w-12')
            self.assertEqual(args[args.index('--max-depth')+1],'20')
            self.assertIn('--compact',args)
            self.assertNotIn('--headed',args)
            folder=execute.call_args.args[1]
            self.assertTrue(folder.is_dir())
            self.assertFalse((folder/'state').exists())

    def test_action_requires_own_snapshot(self):
        self.snapshot()
        for name,hwnd,ref in [('FairyHidden-other',12,'@snap:e1'),('FairyHidden-test',99,'@snap:e1'),('FairyHidden-test',12,'@foreign:e1')]:
            with self.subTest(name=name,hwnd=hwnd,ref=ref),patch.object(semantic,'_execute') as execute:
                with self.assertRaisesRegex(ValueError,'STALE_REF'):
                    semantic.run(name,hwnd,'click',ref)
                execute.assert_not_called()

    def test_timeout_consumes_refs_without_replay(self):
        self.snapshot()
        with patch.object(semantic,'_execute',side_effect=TimeoutError('test')) as execute:
            with self.assertRaises(TimeoutError):
                semantic.run('FairyHidden-test',12,'click','@snap:e1')
            with self.assertRaisesRegex(ValueError,'STALE_REF'):
                semantic.run('FairyHidden-test',12,'click','@snap:e1')
            self.assertEqual(execute.call_count,1)

    def test_value_uses_stdin_not_command_arguments(self):
        self.snapshot()
        with patch.object(semantic,'_execute',return_value={'ok':True}) as execute:
            semantic.run('FairyHidden-test',12,'set_value','@snap:e1','private text')
            self.assertEqual(execute.call_args.args[2],['set-value','@snap:e1','--stdin'])
            self.assertEqual(execute.call_args.args[3],'private text')

    def test_refs_expire(self):
        with patch.object(semantic.time,'monotonic',return_value=100):
            self.snapshot()
        with patch.object(semantic.time,'monotonic',return_value=161):
            with self.assertRaisesRegex(ValueError,'STALE_REF'):
                semantic.run('FairyHidden-test',12,'expand','@snap:e1')

    def test_forbidden_actions_and_flags_rejected(self):
        for action in ['press','type','focus','launch','--headed']:
            with self.subTest(action=action),self.assertRaisesRegex(ValueError,'INVALID_ARGUMENT'):
                semantic.run('FairyHidden-test',12,action)
        with self.assertRaisesRegex(ValueError,'INVALID_ARGUMENT'):
            semantic.run('FairyHidden-test',12,surface='desktop')

    def test_snapshot_failure_cannot_leave_old_refs(self):
        self.snapshot()
        with patch.object(semantic,'_execute',return_value={'ok':False}):
            semantic.run('FairyHidden-test',12)
        with self.assertRaisesRegex(ValueError,'STALE_REF'):
            semantic.run('FairyHidden-test',12,'click','@snap:e1')

    def test_invalidation_preserves_state_directory(self):
        self.snapshot()
        item=semantic._scopes[('fairyhidden-test',12)]
        folder=item['folder']
        semantic.invalidate('FairyHidden-test')
        self.assertTrue(folder.is_dir())
        self.assertFalse(item['refs'])

    def test_action_consumes_other_window_refs_on_same_desktop(self):
        self.snapshot(hwnd=12)
        self.snapshot(hwnd=13)
        with patch.object(semantic,'_execute',return_value={'ok':True}):
            semantic.run('FairyHidden-test',12,'collapse','@snap:e1')
        with self.assertRaisesRegex(ValueError,'STALE_REF'):
            semantic.run('FairyHidden-test',13,'click','@snap:e1')

    def test_scope_count_bounded_and_reset_does_not_cross_desktop(self):
        for hwnd in range(20):
            self.snapshot(hwnd=hwnd+1)
        self.assertEqual(len(semantic._scopes),16)
        self.snapshot(name='FairyHidden-other',hwnd=30)
        semantic.reset('FairyHidden-test')
        self.assertEqual(list(semantic._scopes),[('fairyhidden-other',30)])

    def test_supervisor_root_contains_all_scope_state(self):
        with tempfile.TemporaryDirectory(prefix='fairymouse-semantic-worker-') as folder:
            previous=semantic._root
            try:
                semantic.configure_root(folder)
                self.snapshot()
                scope=semantic._scopes[('fairyhidden-test',12)]['folder']
                self.assertEqual(scope.parent,Path(folder).resolve())
                self.assertFalse((scope/'state').exists())
                semantic.reset()
                self.assertFalse(scope.exists())
                self.assertTrue(Path(folder).is_dir())
            finally:
                semantic.reset()
                semantic._root=previous

    def test_unrelated_cache_root_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='unrelated-') as folder:
            with self.assertRaisesRegex(ValueError,'INVALID_CACHE_ROOT'):
                semantic.configure_root(folder)

    def test_helper_timeout_closes_job_and_process_handles(self):
        def create(*args):
            pi=ctypes.cast(args[-1],ctypes.POINTER(semantic.winio.PROCESS_INFORMATION)).contents
            pi.hProcess,pi.hThread,pi.dwProcessId=101,102,103
            return 1
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(semantic.k,'CreateJobObjectW',return_value=99), \
             patch.object(semantic.k,'SetInformationJobObject',return_value=1), \
             patch.object(semantic.k,'CreateProcessW',side_effect=create), \
             patch.object(semantic.k,'AssignProcessToJobObject',return_value=1), \
             patch.object(semantic.k,'ResumeThread',return_value=1), \
             patch.object(semantic.k,'WaitForSingleObject',side_effect=[258,0]), \
             patch.object(semantic.k,'CloseHandle',return_value=1) as close:
            with self.assertRaisesRegex(TimeoutError,'TIMEOUT_UNKNOWN_OUTCOME'):
                semantic._execute('fairyhidden-test',Path(folder),['snapshot'])
            self.assertEqual([call.args[0] for call in close.call_args_list],[99,102,101])
            self.assertFalse((Path(folder)/'stdin.txt').exists())

    def test_job_assignment_failure_never_resumes_helper(self):
        def create(*args):
            pi=ctypes.cast(args[-1],ctypes.POINTER(semantic.winio.PROCESS_INFORMATION)).contents
            pi.hProcess,pi.hThread=101,102
            return 1
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(semantic.k,'CreateJobObjectW',return_value=99), \
             patch.object(semantic.k,'SetInformationJobObject',return_value=1), \
             patch.object(semantic.k,'CreateProcessW',side_effect=create), \
             patch.object(semantic.k,'AssignProcessToJobObject',return_value=0), \
             patch.object(semantic.k,'ResumeThread') as resume, \
             patch.object(semantic.k,'TerminateProcess',return_value=1) as terminate, \
             patch.object(semantic.k,'WaitForSingleObject',return_value=0), \
             patch.object(semantic.k,'CloseHandle',return_value=1):
            with self.assertRaisesRegex(RuntimeError,'HELPER_ISOLATION_FAILED'):
                semantic._execute('fairyhidden-test',Path(folder),['snapshot'])
            resume.assert_not_called()
            terminate.assert_called_once_with(101,125)


if __name__=='__main__':
    unittest.main()
