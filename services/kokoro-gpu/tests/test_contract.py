from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contract import sanitize_for_synth, text_len_bucket


class ContractTests(unittest.TestCase):
    def test_sanitizer_removes_controls_and_invisibles(self) -> None:
        self.assertEqual(
            sanitize_for_synth('  Hello\x00\u200b\tworld\u00a0again  '),
            'Hello world again',
        )

    def test_sanitizer_preserves_dash_punctuation(self) -> None:
        self.assertEqual(sanitize_for_synth('one—two – three'), 'one—two – three')

    def test_length_buckets_cover_boundaries(self) -> None:
        cases = {
            0: 'xs', 49: 'xs', 50: 's', 199: 's', 200: 'm',
            499: 'm', 500: 'l', 999: 'l', 1000: 'xl', 2000: 'xl',
        }
        for length, expected in cases.items():
            with self.subTest(length=length):
                self.assertEqual(text_len_bucket(length), expected)


if __name__ == '__main__':
    unittest.main()
