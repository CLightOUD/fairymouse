"""Resource-accounting boundaries and windowless child cleanup; no desktop input."""
import unittest
from unittest.mock import patch
import subprocess
import sys
import resource_usage as resource
from resource_usage import cpu_percent, eligible_child


class AccountingTests(unittest.TestCase):
    def test_cpu_is_one_core_not_machine_normalized(self):
        self.assertAlmostEqual(cpu_percent(2, 2.5, 2), 25)
        self.assertAlmostEqual(cpu_percent(2, 6, 2), 200)

    def test_invalid_intervals_fail_instead_of_reporting_idle(self):
        for first,last,seconds in [(0,1,0),(0,1,-1),(2,1,1)]:
            with self.assertRaises(ValueError):
                cpu_percent(first,last,seconds)

    def test_reused_parent_cannot_adopt_older_process(self):
        self.assertFalse(eligible_child(200,100))
        self.assertTrue(eligible_child(200,200))
        self.assertTrue(eligible_child(200,300))

    def test_measurement_and_discovery_failure_still_close_real_child_stdin(self):
        # A real, windowless child waits for EOF. Broken statistics must neither
        # strand it nor turn missing measurements into a passing report.
        children = []
        class WaitingClient:
            ready_ms = 0
            def __init__(self, route, tracker):
                self.process = subprocess.Popen([sys.executable, '-B', '-c', 'import sys;sys.stdin.read()'],
                    stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NO_WINDOW)
                tracker.register(self.process.pid, root=True)
                children.append(self)
                self.disposed = False
            def initialize(self): return 26
            def call(self, tool, args=None): return {}
            def shutdown(self): self.process.stdin.close()
            def dispose(self):
                self.process._handle.Close()
                self.disposed = True
        with patch.object(resource, 'Client', WaitingClient), \
             patch.object(resource.Tracker, 'sample', side_effect=OSError('injected accounting failure')), \
             patch.object(resource.Tracker, 'scan', side_effect=OSError('injected discovery failure')):
            result = resource.scenario('desktop', 1, .5)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['cleanup']['aliveAfterShutdown'], 0)
        self.assertEqual(result['cleanup']['rootExitCodes'], [0])
        self.assertIsNone(result['cleanup']['handlesAfterShutdown'])
        self.assertTrue(children[0].process.stdin.closed)
        self.assertTrue(children[0].disposed)
        self.assertTrue(any('accounting' in error for error in result['cleanupErrors']))
        self.assertTrue(any('discovery' in error for error in result['cleanupErrors']))

    def test_one_handle_close_failure_does_not_skip_other_handles(self):
        tracker = resource.Tracker()
        tracker.items = {(1, 1): {'handle': 111}, (2, 2): {'handle': 222}}
        with patch.object(resource.K, 'CloseHandle', side_effect=[0, 1]) as close:
            with self.assertRaisesRegex(RuntimeError, 'cleanup incomplete'):
                tracker.close()
        self.assertEqual([call.args[0] for call in close.call_args_list], [111, 222])
        self.assertEqual(list(tracker.items), [(1, 1)])
        # Fake failing handles are retained for a potential retry, never passed
        # to the real kernel by this test.
        tracker.items.clear()


if __name__ == '__main__':
    unittest.main()
