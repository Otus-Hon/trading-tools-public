import unittest
from datetime import date

from futu_market_data import (
    contract_code_for_month,
    next_month,
    select_unexpired_contract,
)


class FuturesExpirySelectionTests(unittest.TestCase):
    def test_contract_code_uses_hong_kong_calendar_month(self):
        self.assertEqual(contract_code_for_month(date(2026, 7, 30)), "HK.HSI2607")
        self.assertEqual(contract_code_for_month(next_month(date(2026, 12, 15))), "HK.HSI2701")

    def test_keeps_current_month_on_final_trading_date(self):
        rows = [
            ("HK.HSI2607", {"last_trade_time": "2026-07-30"}),
            ("HK.HSI2608", {"last_trade_time": "2026-08-28"}),
        ]
        selected = select_unexpired_contract(rows, date(2026, 7, 30))
        self.assertEqual(selected[0], "HK.HSI2607")
        self.assertEqual(selected[2], "2026-07-30")

    def test_rolls_only_after_current_contract_expired(self):
        rows = [
            ("HK.HSI2607", {"last_trade_time": "2026-07-30"}),
            ("HK.HSI2608", {"last_trade_time": "2026-08-28"}),
        ]
        selected = select_unexpired_contract(rows, date(2026, 7, 31))
        self.assertEqual(selected[0], "HK.HSI2608")
        self.assertEqual(selected[2], "2026-08-28")

    def test_rejects_invalid_provider_expiry_date(self):
        rows = [
            ("HK.HSI2607", {"last_trade_time": "not-a-date"}),
            ("HK.HSI2608", {"last_trade_time": "2026-08-28"}),
        ]
        selected = select_unexpired_contract(rows, date(2026, 7, 30))
        self.assertEqual(selected[0], "HK.HSI2608")


if __name__ == "__main__":
    unittest.main()
