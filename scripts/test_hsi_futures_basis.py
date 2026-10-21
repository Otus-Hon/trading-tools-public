import unittest
from hsi_futures_basis import matched_basis

class BasisTests(unittest.TestCase):
    def test_discount_uses_matched_time_not_overnight_future(self):
        result = matched_basis({900: {'close': 25300}, 1800: {'close': 25200}}, {900: {'close': 25400}}, 2000)
        self.assertEqual(result['points'], -100)
        self.assertEqual(result['time'], 900)
        self.assertEqual(25350 + result['points'], 25250)

    def test_premium(self):
        self.assertEqual(matched_basis({900: {'close': 25500}}, {900: {'close': 25400}}, 1000)['points'], 100)

    def test_no_shared_timestamp(self):
        self.assertIsNone(matched_basis({900: {'close': 25500}}, {1800: {'close': 25400}}, 2000))

    def test_unfinished_or_invalid_bar_excluded(self):
        self.assertIsNone(matched_basis({1800: {'close': 25500}}, {1800: {'close': 25400}}, 1700))
        self.assertIsNone(matched_basis({900: {'close': float('nan')}}, {900: {'close': 25400}}, 2000))

if __name__ == '__main__':
    unittest.main()
