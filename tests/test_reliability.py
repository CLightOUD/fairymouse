"""Failure-path checks; no user applications or physical input are used."""
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'hidden'))
import server
from vendor import winio


class ReliabilityTests(unittest.TestCase):
    def test_post_failure_is_not_success(self):
        with patch.object(winio.user32, 'PostMessageW', return_value=0), \
             patch.object(winio, '_deepest_child_at', return_value=(1, 0, 0)):
            with self.assertRaises(winio.WinIOError):
                winio._send_click_impl(1, 0, 0, 'left', False)

    def test_text_requires_message_result_and_matching_readback(self):
        with patch.object(winio.user32, 'IsWindow', return_value=1), \
             patch.object(winio, '_send_timeout', return_value=1), \
             patch.object(winio, '_get_window_text', return_value='different'):
            result = winio.set_control_text(1, 'requested')
            self.assertFalse(result['ok'])
            self.assertEqual(result['status'], 'verification_failed')

    def test_native_send_timeout_is_bounded(self):
        with patch.object(winio.user32, 'SendMessageTimeoutW', return_value=0) as send:
            with self.assertRaises(winio.WinIOError):
                winio._get_window_text(1)
            self.assertLessEqual(send.call_args.args[5], 500)

    def test_failed_release_keeps_handle_for_recovery(self):
        with patch.dict(winio._DESKTOPS, {'test': 42}, clear=True), \
             patch.object(winio.user32, 'CloseDesktop', return_value=0):
            with self.assertRaises(winio.WinIOError):
                winio.close_desktop('test')
            self.assertEqual(winio._DESKTOPS['test'], 42)

    def test_scoped_worker_never_falls_back_to_other_desktops(self):
        winio._operation_deadline.value = 1
        try:
            with patch.object(winio.user32, 'IsWindow', return_value=0), \
                 patch.object(winio, '_enum_desktop_names') as enumerate_desktops:
                with self.assertRaises(winio.WinIOError):
                    winio.run_on_window_desktop(1, lambda: self.fail('Executed'))
                enumerate_desktops.assert_not_called()
        finally:
            del winio._operation_deadline.value

    def test_timeout_blocks_more_native_work_until_original_finishes(self):
        release = threading.Event()
        started = threading.Event()
        name = 'fairyhidden-unit'
        def blocked():
            started.set()
            release.wait(2)
        with patch.dict(winio._DESKTOPS, {name: 42}, clear=True), \
             patch.object(winio, 'create_desktop'), \
             patch.object(winio.user32, 'SetThreadDesktop', return_value=1):
            try:
                with self.assertRaises(TimeoutError):
                    server._on_desktop(name, blocked, timeout=.03)
                self.assertTrue(started.is_set())
                self.assertEqual(server.hidden_status()['status'], 'busy')
                with self.assertRaisesRegex(RuntimeError, 'BUSY_UNKNOWN_OUTCOME'):
                    server._on_desktop(name, lambda: self.fail('Overlapping operation'))
            finally:
                release.set()
                server._active.join(2)
                server._sessions.pop(name, None)
            self.assertEqual(server.hidden_status()['status'], 'ready')

    def test_error_contract(self):
        error = server._error(TimeoutError('TIMEOUT_UNKNOWN_OUTCOME: inspect first'))
        self.assertTrue(error.isError)
        self.assertEqual(error.structuredContent['code'], 'TIMEOUT_UNKNOWN_OUTCOME')
        self.assertFalse(error.structuredContent['retry_safe'])

    def test_failed_action_cannot_be_hidden_by_matching_postcondition(self):
        entry = {'handle': 1, '_identity': ['identity', 'already matching']}
        with patch.object(server, '_on_desktop', side_effect=lambda name, operation, **kw: operation()), \
             patch.object(server, '_validate_window'), \
             patch.object(server.observations, 'resolve', return_value=entry), \
             patch.object(server.observations, 'invalidate'), \
             patch.object(winio.user32, 'GetWindowDpiAwarenessContext', return_value=0), \
             patch.object(winio, 'set_control_text', return_value={'status': 'verification_failed', 'verified': False}), \
             patch.object(server.observations, 'identity') as inspect:
            result = server.hidden_act('FairyHidden-unit', 'ref', 'set_text', text='new',
                                      expect_ref='other', expect_text='already matching')
            self.assertFalse(result['verified'])
            self.assertEqual(result['status'], 'verification_failed')
            inspect.assert_not_called()

    def test_desktop_names_are_case_insensitive(self):
        self.assertEqual(server._name('FairyHidden-Test'), server._name('fairyhidden-test'))
        with self.assertRaises(ValueError):
            server._name('Default')


if __name__ == '__main__':
    unittest.main()
