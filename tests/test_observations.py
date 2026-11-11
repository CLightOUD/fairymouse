"""Reference/diff and real cross-process lease tests; no user UI is touched."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'hidden'))
import observations as obs


class ReferenceTests(unittest.TestCase):
    def setUp(self):
        obs._snapshots.clear()

    def remember(self, rows=None, fingerprint=None):
        with patch.object(obs, 'identity', return_value=fingerprint or ['process', 1]):
            return obs.remember('fairyhidden-test', 10, rows or [{'handle': 11, 'text': 'before'}])

    def test_reference_rejects_changed_identity_before_action(self):
        _, entries = self.remember()
        with patch.object(obs, 'identity', return_value=['another-process', 2]):
            with self.assertRaisesRegex(ValueError, 'STALE_REF'):
                obs.resolve(entries[0]['ref'], 'fairyhidden-test')

    def test_reference_rejects_other_desktop_and_bad_index(self):
        key, entries = self.remember()
        for ref, name in [(entries[0]['ref'], 'fairyhidden-other'), (key+':-1', 'fairyhidden-test'),
                          (key+':99', 'fairyhidden-test'), ('not-a-ref', 'fairyhidden-test')]:
            with self.subTest(ref=ref, name=name):
                with self.assertRaisesRegex(ValueError, 'STALE_REF'):
                    obs.resolve(ref, name, check=False)

    def test_snapshot_scope_and_expiry(self):
        with patch.object(obs.time, 'monotonic', return_value=100):
            key, entries = self.remember()
        with patch.object(obs.time, 'monotonic', return_value=161):
            with self.assertRaisesRegex(ValueError, 'STALE_SNAPSHOT'):
                obs.snapshot(key, 'fairyhidden-test', 10)
            with self.assertRaisesRegex(ValueError, 'STALE_REF'):
                obs.resolve(entries[0]['ref'], 'fairyhidden-test', check=False)
        with patch.object(obs.time, 'monotonic', return_value=101):
            with self.assertRaisesRegex(ValueError, 'STALE_SNAPSHOT'):
                obs.snapshot(key, 'fairyhidden-test', 999)

    def test_snapshot_count_is_bounded_and_eviction_invalidates_refs(self):
        first, entries = self.remember()
        for _ in range(33):
            self.remember()
        self.assertLessEqual(len(obs._snapshots), 32)
        self.assertNotIn(first, obs._snapshots)
        with self.assertRaisesRegex(ValueError, 'STALE_REF'):
            obs.resolve(entries[0]['ref'], 'fairyhidden-test', check=False)

    def test_unverifiable_target_has_no_reference(self):
        with patch.object(obs, 'identity', side_effect=ValueError('disappeared')):
            _, entries = obs.remember('fairyhidden-test', 10, [{'handle': 11}])
        self.assertIsNone(entries[0]['ref'])

    def test_diff_ignores_new_reference_ids_but_reports_content(self):
        before = [{'handle': 1, 'text': 'old', 'ref': 'a:0', '_identity': ['x']},
                  {'handle': 2, 'text': 'gone', 'ref': 'a:1'}]
        after = [{'handle': 1, 'text': 'new', 'ref': 'b:0', '_identity': ['x']},
                 {'handle': 3, 'text': 'added', 'ref': 'b:1'}]
        diff = obs.difference(before, after)
        self.assertEqual(diff['removed'], [2])
        self.assertEqual(diff['added'][0]['handle'], 3)
        self.assertEqual(diff['changed'][0]['fields']['text'], 'new')
        self.assertNotIn('_identity', str(diff))
        self.assertEqual(obs.difference([before[0]], [{**before[0], 'ref': 'new:0'}])['changed'], [])

    def test_consumed_ref_preserves_diff_baseline(self):
        key, entries = self.remember()
        obs.invalidate('fairyhidden-test')
        with self.assertRaisesRegex(ValueError, 'STALE_REF'):
            obs.resolve(entries[0]['ref'], 'fairyhidden-test', check=False)
        self.assertEqual(obs.snapshot(key, 'fairyhidden-test', 10)['entries'], entries)

    def test_release_invalidates_only_owned_scope(self):
        key, _ = self.remember()
        with patch.object(obs, 'identity', return_value=['process', 2]):
            other, _ = obs.remember('fairyhidden-other', 12, [{'handle': 13}])
        obs.release('fairyhidden-test')
        self.assertNotIn(key, obs._snapshots)
        self.assertIn(other, obs._snapshots)

    def test_diff_reports_reused_handle_identity(self):
        before = [{'handle': 1, 'text': 'same', 'ref': 'a:0', '_identity': [123, 1]}]
        after = [{'handle': 1, 'text': 'same', 'ref': 'b:0', '_identity': [456, 2]}]
        diff = obs.difference(before, after)
        self.assertTrue(diff['changed'][0]['fields']['identity_changed'])
        self.assertNotIn('_identity', str(diff))


class LeaseTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / 'tests' / '.work'
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.env = {**os.environ, 'LOCALAPPDATA': self.temp.name,
                    'PYTHONPATH': str(ROOT / 'hidden'), 'PYTHONDONTWRITEBYTECODE': '1'}

    def tearDown(self):
        self.temp.cleanup()

    def child(self, script):
        return subprocess.Popen([sys.executable, '-B', '-u', '-c', script], env=self.env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, creationflags=subprocess.CREATE_NO_WINDOW)

    def probe(self, name):
        return subprocess.run([sys.executable, '-B', '-c',
                               'import observations as o; o.claim('+repr(name)+'); print("claimed"); o.release('+repr(name)+')'],
                              env=self.env, capture_output=True, text=True, timeout=10,
                              creationflags=subprocess.CREATE_NO_WINDOW)

    def test_exclusive_ownership_distinct_desktops_and_clean_release(self):
        owner = self.child('import observations as o; o.claim("fairyhidden-one"); print("ready",flush=True); input(); o.release("fairyhidden-one")')
        try:
            self.assertEqual(owner.stdout.readline().strip(), 'ready')
            refused = self.probe('fairyhidden-one')
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn('DESKTOP_OWNED', refused.stderr)
            self.assertNotEqual(self.probe('FairyHidden-One').returncode, 0)
            self.assertEqual(self.probe('fairyhidden-two').returncode, 0)
            owner.communicate('\n', timeout=10)
            self.assertEqual(self.probe('fairyhidden-one').returncode, 0)
        finally:
            if owner.poll() is None:
                owner.kill()
            owner.communicate(timeout=10)

    def test_process_death_releases_os_lock(self):
        owner = self.child('import observations as o; o.claim("fairyhidden-crash"); print("ready",flush=True); input()')
        try:
            self.assertEqual(owner.stdout.readline().strip(), 'ready')
            self.assertNotEqual(self.probe('fairyhidden-crash').returncode, 0)
            owner.kill()
            owner.communicate(timeout=10)
            self.assertEqual(self.probe('fairyhidden-crash').returncode, 0)
        finally:
            if owner.poll() is None:
                owner.kill()
            owner.communicate(timeout=10)


if __name__ == '__main__':
    unittest.main()
