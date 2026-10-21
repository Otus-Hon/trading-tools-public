"""Order-driven single-symbol OHLC backtesting engine.

Strategies describe order intent.  This module owns fills, positions, risk,
costs and accounting.  It intentionally has no dependency on user code.
"""

from __future__ import annotations

from dataclasses import dataclass
import math


POINT_VALUE = 50.0


@dataclass
class Order:
    id: str
    side: str
    type: str
    submitted_index: int
    price: float | None = None
    stop_loss: float | None = None
    take_profit: float | None = None
    reward_risk: float | None = None
    quantity: float | None = None
    expiry: str = "DAY"
    comment: str = ""
    oco_group: str = ""
    trailing_stop: dict | None = None
    legacy: bool = False


def _number(value, default=None):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def normalize_orders(result: dict, bars: list[dict]) -> list[Order]:
    """Validate native orders or translate the legacy signal-array contract."""
    normalized: list[Order] = []
    raw_orders = result.get("orders")
    if isinstance(raw_orders, list):
        time_to_index = {int(bar["time"]): i for i, bar in enumerate(bars)}
        for seq, raw in enumerate(raw_orders):
            if not isinstance(raw, dict):
                raise ValueError(f"orders[{seq}] must be a dictionary.")
            side = str(raw.get("side", "")).lower()
            kind = str(raw.get("type", "market")).lower()
            if side not in {"buy", "sell"}:
                raise ValueError(f"orders[{seq}].side must be buy or sell.")
            if kind not in {"market", "stop", "limit"}:
                raise ValueError(f"orders[{seq}].type must be market, stop or limit.")
            index = raw.get("bar_index")
            if index is None and raw.get("time") is not None:
                index = time_to_index.get(int(raw["time"]))
            if not isinstance(index, int) or index < 0 or index >= len(bars):
                raise ValueError(f"orders[{seq}] needs a valid bar_index (submission after that bar closes).")
            price = _number(raw.get("price"))
            if kind != "market" and price is None:
                raise ValueError(f"orders[{seq}].price is required for {kind} orders.")
            trailing_stop = raw.get("trailing_stop") if isinstance(raw.get("trailing_stop"), dict) else None
            if trailing_stop and str(trailing_stop.get("type", "atr")).lower() != "atr":
                raise ValueError(f"orders[{seq}].trailing_stop.type currently supports only atr.")
            normalized.append(Order(
                id=str(raw.get("id") or f"order-{seq + 1}"), side=side, type=kind,
                submitted_index=index, price=price, stop_loss=_number(raw.get("stop_loss")),
                take_profit=_number(raw.get("take_profit")), reward_risk=_number(raw.get("reward_risk")),
                quantity=_number(raw.get("quantity")), expiry=str(raw.get("expiry", "DAY")).upper(),
                comment=str(raw.get("comment", ""))[:160], oco_group=str(raw.get("oco_group", ""))[:80],
                trailing_stop=trailing_stop,
            ))

    raw_signals = result.get("signals")
    if raw_signals is not None:
        if not isinstance(raw_signals, list) or len(raw_signals) != len(bars):
            raise ValueError("signals must contain exactly one value per bar.")
        stop_prices = result.get("stop_prices") if isinstance(result.get("stop_prices"), list) and len(result["stop_prices"]) == len(bars) else None
        target_prices = result.get("target_prices") if isinstance(result.get("target_prices"), list) and len(result["target_prices"]) == len(bars) else None
        atr_period = max(1, int(_number(result.get("atr_period"), 14)))
        stop_atr = max(0.1, _number(result.get("stop_atr"), 1.5))
        target_atr = max(0.1, _number(result.get("target_atr"), 3.0))
        true_ranges = []
        for index, bar in enumerate(bars):
            previous = bars[index - 1]["close"] if index else bar["close"]
            true_ranges.append(max(bar["high"] - bar["low"], abs(bar["high"] - previous), abs(bar["low"] - previous)))
        for index, value in enumerate(raw_signals):
            signal = _number(value, 0)
            if not signal:
                continue
            atr_start = max(0, index - atr_period + 1)
            atr = sum(true_ranges[atr_start:index + 1]) / max(1, index - atr_start + 1)
            side = "buy" if signal > 0 else "sell"
            fallback_stop = bars[index]["close"] - atr * stop_atr if side == "buy" else bars[index]["close"] + atr * stop_atr
            fallback_target = bars[index]["close"] + atr * target_atr if side == "buy" else bars[index]["close"] - atr * target_atr
            normalized.append(Order(
                id=f"legacy-{index}", side=side, type="market",
                submitted_index=index, stop_loss=_number(stop_prices[index], fallback_stop) if stop_prices else fallback_stop,
                take_profit=_number(target_prices[index], fallback_target) if target_prices else fallback_target,
                reward_risk=_number(result.get("reward_risk")), expiry="DAY", legacy=True,
            ))
    if not normalized:
        return []
    normalized.sort(key=lambda order: (order.submitted_index, order.id))
    return normalized


class BacktestEngine:
    def __init__(self, bars: list[dict], orders: list[Order], settings: dict):
        self.bars = bars
        self.orders = orders
        self.initial_capital = max(1.0, _number(settings.get("initial_capital"), 100000.0))
        self.equity = self.initial_capital
        self.risk_percent = min(100.0, max(0.01, _number(settings.get("risk_percent"), 1.0)))
        self.point_value = max(0.01, _number(settings.get("point_value"), POINT_VALUE))
        self.spread = max(0.0, _number(settings.get("spread_points", settings.get("cost_points")), 0.0))
        self.slippage = max(0.0, _number(settings.get("slippage_points"), 0.0))
        self.commission = max(0.0, _number(settings.get("commission_hkd"), 0.0))
        self.margin_per_contract = max(0.0, _number(settings.get("margin_per_contract"), 0.0))
        self.execution_mode = str(settings.get("execution_mode", "intrabar_ohlc")).lower()
        self.ambiguity = str(settings.get("ambiguity_policy", "nearest")).lower()
        if self.execution_mode not in {"next_bar_open", "current_bar_close", "intrabar_ohlc"}:
            raise ValueError("execution_mode must be next_bar_open, current_bar_close or intrabar_ohlc.")
        if self.ambiguity not in {"worst_case", "best_case", "open_high_low_close", "open_low_high_close", "nearest"}:
            raise ValueError("Unsupported ambiguity_policy.")
        self.position = None
        self.pending: list[Order] = []
        self.trades: list[dict] = []
        self.order_log: list[dict] = []
        self.cancelled_oco: set[str] = set()
        self.true_ranges = []
        for index, bar in enumerate(bars):
            previous = bars[index - 1]["close"] if index else bar["close"]
            self.true_ranges.append(max(bar["high"] - bar["low"], abs(bar["high"] - previous), abs(bar["low"] - previous)))

    def _day(self, index: int) -> str:
        return str(self.bars[index].get("timeKey", ""))[:10]

    def _entry_triggered(self, order: Order, bar: dict) -> bool:
        if order.type == "stop":
            return bar["high"] >= order.price if order.side == "buy" else bar["low"] <= order.price
        if order.type == "limit":
            return bar["low"] <= order.price if order.side == "buy" else bar["high"] >= order.price
        return True

    def _fill_price(self, order: Order, reference: float) -> float:
        base = reference if order.type == "market" else float(order.price)
        adverse = self.spread / 2.0 + self.slippage
        return base + adverse if order.side == "buy" else base - adverse

    def _exit_fill(self, raw_price: float, direction: str) -> float:
        adverse = self.spread / 2.0 + self.slippage
        return raw_price - adverse if direction == "long" else raw_price + adverse

    def _atr(self, index: int, period: int) -> float:
        start = max(0, index - period + 1)
        values = self.true_ranges[start:index + 1]
        return sum(values) / len(values) if values else 0.0

    def _resolve_bracket(self, bar: dict, position: dict) -> tuple[float, str] | None:
        direction = position["direction"]
        initial_stop = position["stopPrice"]
        trailing = position.get("trailingPrice")
        if direction == "long":
            stop = max(value for value in (initial_stop, trailing) if value is not None)
        else:
            stop = min(value for value in (initial_stop, trailing) if value is not None)
        target = position["targetPrice"]
        stop_hit = stop is not None and (bar["low"] <= stop if direction == "long" else bar["high"] >= stop)
        target_hit = target is not None and (bar["high"] >= target if direction == "long" else bar["low"] <= target)
        if not stop_hit and not target_hit:
            return None
        stop_reason = "TRAILING_STOP" if trailing is not None and stop == trailing else "SL"
        if stop_hit and not target_hit:
            return stop, stop_reason
        if target_hit and not stop_hit:
            return target, "TP"
        if self.ambiguity == "best_case":
            return target, "TP"
        if self.ambiguity == "nearest":
            return (stop, stop_reason) if abs(bar["open"] - stop) <= abs(bar["open"] - target) else (target, "TP")
        if self.ambiguity == "open_high_low_close":
            return (target, "TP") if direction == "long" else (stop, stop_reason)
        if self.ambiguity == "open_low_high_close":
            return (stop, stop_reason) if direction == "long" else (target, "TP")
        return stop, stop_reason

    def _update_trailing(self, index: int, bar: dict) -> tuple[float, str] | None:
        position = self.position
        config = position.get("trailingConfig") if position else None
        if not position or not config:
            return None
        period = max(1, int(_number(config.get("period"), 14)))
        multiple = max(0.01, _number(config.get("multiple"), 2.0))
        activate_r = max(0.0, _number(config.get("activate_after_r"), 0.0))
        atr = self._atr(index, period)
        if atr <= 0:
            return None
        direction = position["direction"]
        previous_best = position["bestPrice"]
        favorable = bar["high"] if direction == "long" else bar["low"]
        best = max(previous_best, favorable) if direction == "long" else min(previous_best, favorable)
        position["bestPrice"] = best
        initial_risk = position["initialRisk"]
        progress = best - position["entryPrice"] if direction == "long" else position["entryPrice"] - best
        if progress < initial_risk * activate_r:
            return None
        candidate = best - atr * multiple if direction == "long" else best + atr * multiple
        previous_trail = position.get("trailingPrice")
        trail = max(previous_trail, candidate) if direction == "long" and previous_trail is not None else min(previous_trail, candidate) if direction == "short" and previous_trail is not None else candidate
        # A trailing exit must never loosen the original protective stop.
        trail = max(trail, position["stopPrice"]) if direction == "long" else min(trail, position["stopPrice"])
        position["trailingPrice"] = trail
        hit = bar["low"] <= trail if direction == "long" else bar["high"] >= trail
        if not hit:
            return None
        # The candle contains both the favorable extreme that moved the trail and
        # the retracement. Resolve their unknown sequence with the selected policy.
        if self.ambiguity == "best_case":
            return None
        if self.ambiguity == "open_high_low_close":
            return (trail, "TRAILING_STOP") if direction == "long" else None
        if self.ambiguity == "open_low_high_close":
            return (trail, "TRAILING_STOP") if direction == "short" else None
        if self.ambiguity == "nearest":
            favorable_distance = abs(bar["open"] - favorable)
            adverse_extreme = bar["low"] if direction == "long" else bar["high"]
            adverse_distance = abs(bar["open"] - adverse_extreme)
            return (trail, "TRAILING_STOP") if favorable_distance <= adverse_distance else None
        return trail, "TRAILING_STOP"

    def _close(self, index: int, raw_price: float, reason: str):
        position = self.position
        if not position:
            return
        exit_price = self._exit_fill(raw_price, position["direction"])
        sign = 1 if position["direction"] == "long" else -1
        pnl_per_contract = (exit_price - position["entryPrice"]) * sign
        pnl_hkd = pnl_per_contract * position["contracts"] * self.point_value - self.commission * position["contracts"]
        self.equity += pnl_hkd
        self.trades.append({
            "id": len(self.trades), "orderId": position["orderId"], "direction": position["direction"],
            "entryTime": position["entryTime"], "exitTime": self.bars[index]["time"],
            "entryPrice": position["entryPrice"], "exitPrice": exit_price,
            "stopPrice": position["stopPrice"], "targetPrice": position["targetPrice"],
            "trailingStopPrice": position.get("trailingPrice"),
            "reason": reason, "pnl": pnl_hkd / self.point_value, "pnlPerContract": pnl_per_contract,
            "pnlHkd": pnl_hkd, "contracts": position["contracts"], "riskAmount": position["riskAmount"],
            "equityAfter": self.equity, "barsHeld": max(1, index - position["entryIndex"] + 1),
            "comment": position["comment"],
        })
        self.position = None

    def _open(self, order: Order, index: int, reference: float):
        direction = "long" if order.side == "buy" else "short"
        if self.position:
            if self.position["direction"] == direction:
                self.order_log.append({"id": order.id, "status": "rejected", "reason": "position already open"})
                return
            self._close(index, reference, "REVERSE")
        entry = self._fill_price(order, reference)
        stop = order.stop_loss
        target = order.take_profit
        if stop is not None and not (stop < entry if direction == "long" else stop > entry):
            self.order_log.append({"id": order.id, "status": "rejected", "reason": "invalid stop"})
            return
        if target is None and stop is not None and order.reward_risk:
            distance = abs(entry - stop) * order.reward_risk
            target = entry + distance if direction == "long" else entry - distance
        if target is not None and not (target > entry if direction == "long" else target < entry):
            self.order_log.append({"id": order.id, "status": "rejected", "reason": "invalid target"})
            return
        if stop is None:
            self.order_log.append({"id": order.id, "status": "rejected", "reason": "stop_loss required for risk sizing"})
            return
        risk_amount = self.equity * self.risk_percent / 100.0
        exit_friction = self.spread / 2.0 + self.slippage
        risk_per_contract = (abs(entry - stop) + exit_friction) * self.point_value + self.commission
        contracts = order.quantity if order.quantity and order.quantity > 0 else risk_amount / risk_per_contract
        if self.margin_per_contract > 0:
            contracts = min(contracts, self.equity / self.margin_per_contract)
        if contracts <= 0:
            return
        self.position = {
            "orderId": order.id, "direction": direction, "entryIndex": index,
            "entryTime": self.bars[index]["time"], "entryPrice": entry,
            "stopPrice": stop, "targetPrice": target, "contracts": contracts,
            "riskAmount": risk_amount, "comment": order.comment,
            "trailingConfig": order.trailing_stop, "trailingPrice": None,
            "bestPrice": entry, "initialRisk": abs(entry - stop),
        }
        if order.oco_group:
            self.cancelled_oco.add(order.oco_group)
        self.order_log.append({"id": order.id, "status": "filled", "time": self.bars[index]["time"], "price": entry})

    def run(self) -> dict:
        by_submission: dict[int, list[Order]] = {}
        for order in self.orders:
            by_submission.setdefault(order.submitted_index, []).append(order)

        for index, bar in enumerate(self.bars):
            # Existing brackets are live from the first bar after entry. Orders
            # filled intrabar are checked again below for same-bar SL/TP.
            if self.position and self.position["entryIndex"] < index:
                bracket = self._resolve_bracket(bar, self.position)
                if bracket:
                    self._close(index, bracket[0], bracket[1])
                elif self.position:
                    trailing_exit = self._update_trailing(index, bar)
                    if trailing_exit:
                        self._close(index, trailing_exit[0], trailing_exit[1])

            still_pending = []
            for order in self.pending:
                if order.oco_group and order.oco_group in self.cancelled_oco:
                    self.order_log.append({"id": order.id, "status": "cancelled", "reason": "OCO peer filled"})
                    continue
                if order.expiry == "DAY" and self._day(index) != self._day(order.submitted_index):
                    self.order_log.append({"id": order.id, "status": "expired"})
                    continue
                if order.type == "market":
                    self._open(order, index, bar["open"])
                elif self._entry_triggered(order, bar):
                    self._open(order, index, float(order.price))
                    if self.position:
                        bracket = self._resolve_bracket(bar, self.position)
                        if bracket:
                            self._close(index, bracket[0], bracket[1])
                        elif self.position:
                            trailing_exit = self._update_trailing(index, bar)
                            if trailing_exit:
                                self._close(index, trailing_exit[0], trailing_exit[1])
                else:
                    still_pending.append(order)
            self.pending = [order for order in still_pending if not order.oco_group or order.oco_group not in self.cancelled_oco]

            for order in by_submission.get(index, []):
                if order.type == "market" and self.execution_mode == "current_bar_close":
                    self._open(order, index, bar["close"])
                elif order.type == "market" and self.execution_mode == "intrabar_ohlc":
                    self._open(order, index, bar["close"])
                else:
                    self.pending.append(order)

        if self.position:
            self._close(len(self.bars) - 1, self.bars[-1]["close"], "END")
        statistics = self._statistics()
        return {
            "trades": self.trades, "orders": self.order_log, "initialCapital": self.initial_capital,
            "endingEquity": self.equity, "statistics": statistics, "settings": {
                "executionMode": self.execution_mode, "ambiguityPolicy": self.ambiguity,
                "spreadPoints": self.spread, "slippagePoints": self.slippage,
                "commissionHkd": self.commission, "pointValue": self.point_value,
            },
        }

    def _statistics(self) -> dict:
        wins = [trade for trade in self.trades if trade["pnlHkd"] > 0]
        losses = [trade for trade in self.trades if trade["pnlHkd"] <= 0]
        gross_profit = sum(trade["pnlHkd"] for trade in wins)
        gross_loss = abs(sum(trade["pnlHkd"] for trade in losses))
        net = sum(trade["pnlHkd"] for trade in self.trades)
        equity = self.initial_capital
        peak = equity
        max_drawdown = 0.0
        max_drawdown_percent = 0.0
        for trade in self.trades:
            equity += trade["pnlHkd"]
            peak = max(peak, equity)
            drawdown = peak - equity
            max_drawdown = max(max_drawdown, drawdown)
            max_drawdown_percent = max(max_drawdown_percent, drawdown / peak * 100 if peak else 0.0)
        returns = [trade["pnlHkd"] / max(1.0, trade["equityAfter"] - trade["pnlHkd"]) for trade in self.trades]
        mean = sum(returns) / len(returns) if returns else 0.0
        variance = sum((value - mean) ** 2 for value in returns) / (len(returns) - 1) if len(returns) > 1 else 0.0
        sharpe = mean / math.sqrt(variance) * math.sqrt(len(returns)) if variance > 0 else 0.0
        return {
            "totalTrades": len(self.trades), "wins": len(wins), "losses": len(losses),
            "winRate": len(wins) / len(self.trades) * 100 if self.trades else 0.0,
            "startingCapital": self.initial_capital, "endingEquity": self.equity,
            "netPnlHkd": net, "totalReturnPercent": net / self.initial_capital * 100,
            "grossProfitHkd": gross_profit, "grossLossHkd": gross_loss,
            "profitFactor": gross_profit / gross_loss if gross_loss else (999.0 if gross_profit else 0.0),
            "averageTradeHkd": net / len(self.trades) if self.trades else 0.0,
            "maxDrawdownHkd": max_drawdown, "maxDrawdownPercent": max_drawdown_percent,
            "sharpeTradeReturns": sharpe,
        }
