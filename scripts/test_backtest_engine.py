import unittest

from backtest_engine import BacktestEngine, normalize_orders


def bars_for(*ohlc):
    return [
        {
            "time": 1_700_000_000 + index * 60,
            "timeKey": f"2026-07-13 09:{15 + index:02d}:00",
            "open": values[0], "high": values[1], "low": values[2], "close": values[3], "volume": 100,
        }
        for index, values in enumerate(ohlc)
    ]


class OrderEngineTests(unittest.TestCase):
    def test_stop_entry_has_same_bar_worst_case_bracket(self):
        bars = bars_for((100, 102, 98, 100), (100, 120, 90, 110), (110, 112, 108, 111))
        orders = normalize_orders({"orders": [{
            "id": "breakout", "bar_index": 0, "side": "buy", "type": "stop", "price": 105,
            "stop_loss": 95, "take_profit": 115, "expiry": "DAY",
        }]}, bars)
        result = BacktestEngine(bars, orders, {"ambiguity_policy": "worst_case", "risk_percent": 1}).run()
        self.assertEqual(result["trades"][0]["reason"], "SL")
        self.assertEqual(result["trades"][0]["entryPrice"], 105)
        self.assertEqual(result["trades"][0]["exitPrice"], 95)

    def test_stop_entry_has_same_bar_best_case_bracket(self):
        bars = bars_for((100, 102, 98, 100), (100, 120, 90, 110))
        orders = normalize_orders({"orders": [{
            "id": "breakout", "bar_index": 0, "side": "buy", "type": "stop", "price": 105,
            "stop_loss": 95, "take_profit": 115,
        }]}, bars)
        result = BacktestEngine(bars, orders, {"ambiguity_policy": "best_case"}).run()
        self.assertEqual(result["trades"][0]["reason"], "TP")

    def test_limit_entry_and_reward_risk_target(self):
        bars = bars_for((100, 101, 99, 100), (100, 103, 94, 102), (102, 111, 101, 110))
        orders = normalize_orders({"orders": [{
            "id": "pullback", "bar_index": 0, "side": "buy", "type": "limit", "price": 95,
            "stop_loss": 90, "reward_risk": 2,
        }]}, bars)
        result = BacktestEngine(bars, orders, {}).run()
        self.assertEqual(result["trades"][0]["targetPrice"], 105)
        self.assertEqual(result["trades"][0]["reason"], "TP")

    def test_oco_cancels_peer(self):
        bars = bars_for((100, 101, 99, 100), (100, 110, 90, 105), (105, 106, 104, 105))
        raw = {"orders": [
            {"id": "long", "bar_index": 0, "side": "buy", "type": "stop", "price": 105, "stop_loss": 95, "take_profit": 120, "oco_group": "orb"},
            {"id": "short", "bar_index": 0, "side": "sell", "type": "stop", "price": 95, "stop_loss": 105, "take_profit": 80, "oco_group": "orb"},
        ]}
        result = BacktestEngine(bars, normalize_orders(raw, bars), {}).run()
        fills = [order for order in result["orders"] if order["status"] == "filled"]
        self.assertEqual(len(fills), 1)

    def test_legacy_signals_translate_to_market_orders(self):
        bars = bars_for(*[(100 + i, 102 + i, 98 + i, 101 + i) for i in range(5)])
        orders = normalize_orders({"signals": [1, 0, 0, 0, 0]}, bars)
        result = BacktestEngine(bars, orders, {"execution_mode": "next_bar_open"}).run()
        self.assertEqual(len(result["trades"]), 1)
        self.assertEqual(result["trades"][0]["entryTime"], bars[1]["time"])

    def test_panel_risk_and_spread_are_used(self):
        bars = bars_for((100, 101, 99, 100), (100, 101, 89, 90))
        orders = normalize_orders({"orders": [{
            "id": "risk", "bar_index": 0, "side": "buy", "type": "market", "stop_loss": 90,
        }]}, bars)
        result = BacktestEngine(bars, orders, {"initial_capital": 200000, "risk_percent": 2, "spread_points": 6}).run()
        trade = result["trades"][0]
        self.assertAlmostEqual(trade["riskAmount"], 4000)
        self.assertAlmostEqual(abs(trade["pnlHkd"]), 4000)

    def test_atr_trailing_exit_ratchets_and_closes(self):
        bars = bars_for(
            (100, 101, 99, 100),
            (100, 120, 110, 118),
            (118, 125, 112, 113),
            (113, 114, 108, 109),
        )
        orders = normalize_orders({"orders": [{
            "id": "trail", "bar_index": 0, "side": "buy", "type": "market",
            "stop_loss": 90, "quantity": 1,
            "trailing_stop": {"type": "atr", "period": 2, "multiple": 1, "activate_after_r": 0},
        }]}, bars)
        result = BacktestEngine(bars, orders, {"execution_mode": "current_bar_close", "ambiguity_policy": "best_case"}).run()
        trade = result["trades"][0]
        self.assertEqual(trade["reason"], "TRAILING_STOP")
        self.assertEqual(trade["trailingStopPrice"], 109)

    def test_same_bar_new_trailing_level_obeys_worst_case(self):
        bars = bars_for((100, 101, 99, 100), (100, 120, 100, 118))
        orders = normalize_orders({"orders": [{
            "id": "trail", "bar_index": 0, "side": "buy", "type": "market",
            "stop_loss": 90, "quantity": 1,
            "trailing_stop": {"type": "atr", "period": 1, "multiple": 0.5, "activate_after_r": 0},
        }]}, bars)
        result = BacktestEngine(bars, orders, {"execution_mode": "current_bar_close", "ambiguity_policy": "worst_case"}).run()
        self.assertEqual(result["trades"][0]["reason"], "TRAILING_STOP")


if __name__ == "__main__":
    unittest.main()
