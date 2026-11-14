"""Injected foreground failure paths; no Windows desktop operations."""
import unittest
from foreground_probe import take_sample, input_desktop_changed


class FakeAPI:
    def __init__(self):
        self.foregrounds = [100, 100]
        self.cursor_result = ((10, 20), None)
        self.desktop_result = ('Default', [])
        self.gui_result = (200, None)
        self.gui_calls = []
        self.identity_results = {}
        self.thread_results = {100: (7, 10, None), 200: (7, 10, None)}

    def foreground(self): return self.foregrounds.pop(0)
    def window_thread(self, hwnd): return self.thread_results[hwnd]
    def cursor(self): return self.cursor_result
    def desktop(self): return self.desktop_result
    def gui_thread(self, thread):
        self.gui_calls.append(thread)
        return self.gui_result
    def identity(self, pid): return self.identity_results.get(pid, ('10:1234', None, None))


class ForegroundProbeTests(unittest.TestCase):
    def reasons(self, sample): return [r['reason'] for r in sample['reasons']]

    def test_stable_sample_uses_specific_thread_not_later_foreground_thread(self):
        api = FakeAPI()
        result = take_sample(api)
        self.assertTrue(result['valid'])
        self.assertEqual(api.gui_calls, [7])
        self.assertEqual(result['foregroundIdentity'], '10:1234')

    def test_null_foreground_is_explicit_gap_without_stale_last_error(self):
        api = FakeAPI()
        api.foregrounds = [0, 0]
        result = take_sample(api)
        self.assertFalse(result['valid'])
        self.assertEqual(result['reasons'], [{'reason': 'FOREGROUND_NULL', 'win32Error': None}])
        self.assertEqual(api.gui_calls, [])

    def test_foreground_change_during_sample_does_not_mix_threads_or_retry(self):
        api = FakeAPI()
        api.foregrounds = [100, 300]
        result = take_sample(api)
        self.assertIn('FOREGROUND_CHANGED_DURING_SAMPLE', self.reasons(result))
        self.assertFalse(result['valid'])
        self.assertEqual(api.gui_calls, [7])
        self.assertEqual(api.foregrounds, [])

    def test_failures_are_independent_not_short_circuited(self):
        api = FakeAPI()
        api.cursor_result = (None, 5)
        api.gui_result = (None, 1444)
        api.desktop_result = (None, [{'reason': 'INPUT_DESKTOP_OPEN_FAILED', 'win32Error': 5}])
        api.identity_results[10] = (None, 'PROCESS_OPEN_FAILED', 87)
        result = take_sample(api)
        self.assertEqual(set(self.reasons(result)), {'CURSOR_READ_FAILED', 'GUI_THREAD_INFO_FAILED',
                         'INPUT_DESKTOP_OPEN_FAILED', 'FOREGROUND_PROCESS_OPEN_FAILED'})
        self.assertEqual(api.gui_calls, [7])
        self.assertFalse(result['valid'])

    def test_disappearing_foreground_window_is_not_a_success(self):
        api = FakeAPI()
        api.thread_results[100] = (0, 0, 1400)
        result = take_sample(api)
        self.assertEqual(result['reasons'][0], {'reason': 'FOREGROUND_THREAD_UNAVAILABLE', 'win32Error': 1400})
        self.assertFalse(result['valid'])

    def test_disappearing_focus_window_is_independently_recorded(self):
        api = FakeAPI()
        api.thread_results[200] = (0, 0, 1400)
        result = take_sample(api)
        self.assertIn('FOCUS_THREAD_UNAVAILABLE', self.reasons(result))
        self.assertFalse(result['valid'])

    def test_no_focused_control_is_valid_when_gui_read_succeeded(self):
        api = FakeAPI()
        api.gui_result = (0, None)
        self.assertTrue(take_sample(api)['valid'])

    def test_process_time_failure_preserves_api_error(self):
        api = FakeAPI()
        api.identity_results[10] = (None, 'PROCESS_TIMES_FAILED', 6)
        result = take_sample(api)
        self.assertEqual({r['reason'] for r in result['reasons']},
                         {'FOREGROUND_PROCESS_TIMES_FAILED', 'FOCUS_PROCESS_TIMES_FAILED'})
        self.assertTrue(all(r['win32Error'] == 6 for r in result['reasons']))

    def test_desktop_permission_failure_is_invalid_not_evidence_of_switch(self):
        api = FakeAPI()
        api.desktop_result = (None, [{'reason': 'INPUT_DESKTOP_OPEN_FAILED', 'win32Error': 5}])
        result = take_sample(api)
        self.assertFalse(result['valid'])
        self.assertIn('INPUT_DESKTOP_OPEN_FAILED', self.reasons(result))
        self.assertFalse(input_desktop_changed('Default', result['desktop']))
        self.assertFalse(input_desktop_changed(None, 'Default'))
        self.assertFalse(input_desktop_changed('Default', ''))
        self.assertFalse(input_desktop_changed('Default', 'Default'))
        self.assertTrue(input_desktop_changed('Default', 'Winlogon'))


if __name__ == '__main__':
    unittest.main()
