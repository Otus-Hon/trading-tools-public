import unittest

from python_strategy_runner import extract_backtest_config


class PythonStrategyConfigTests(unittest.TestCase):
    def test_extracts_complete_code_configuration(self):
        config = extract_backtest_config('''
BACKTEST = {
    "timeframe": "15m",
    "sessions": 27,
    "starting_capital_usd": 75000,
    "spread_points": 4,
    "slippage_points": 1,
    "commission_hkd": 12,
    "risk_percent": 2,
    "point_value": 50,
    "margin_per_contract": 10000,
    "execution_mode": "next_bar_open",
    "ambiguity_policy": "worst_case",
}
def strategy(bars):
    return {"orders": []}
''')
        self.assertEqual(config["timeframe"], "15m")
        self.assertEqual(config["sessions"], 27)
        self.assertEqual(config["starting_capital_usd"], 75000)
        self.assertEqual(config["execution_mode"], "next_bar_open")
        self.assertEqual(config["ambiguity_policy"], "worst_case")

    def test_defaults_are_available_for_legacy_code(self):
        config = extract_backtest_config('def strategy(bars):\n    return {"orders": []}\n')
        self.assertEqual(config["timeframe"], "1m")
        self.assertEqual(config["sessions"], 15)
        self.assertEqual(config["starting_capital_usd"], 50000)

    def test_rejects_unsupported_timeframe(self):
        with self.assertRaisesRegex(ValueError, "timeframe"):
            extract_backtest_config('BACKTEST = {"timeframe": "5m"}\n')


if __name__ == "__main__":
    unittest.main()
