#!/usr/bin/env python3
"""Run a user-authored signal function with restricted Python capabilities."""

import ast
import json
import math
import sys

from backtest_engine import BacktestEngine, normalize_orders


BANNED_NAMES = {
    "__import__", "breakpoint", "compile", "dir", "eval", "exec", "globals",
    "help", "input", "locals", "open", "vars",
}
SAFE_BUILTINS = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
    "enumerate": enumerate, "float": float, "int": int, "len": len,
    "list": list, "max": max, "min": min, "range": range, "round": round,
    "sorted": sorted, "str": str, "sum": sum, "tuple": tuple, "zip": zip,
}

DEFAULT_BACKTEST = {
    "timeframe": "1m",
    "sessions": 15,
    "starting_capital_usd": 50000.0,
    "spread_points": 6.0,
    "slippage_points": 0.0,
    "commission_hkd": 0.0,
    "risk_percent": 1.0,
    "point_value": 50.0,
    "margin_per_contract": 0.0,
    "execution_mode": "intrabar_ohlc",
    "ambiguity_policy": "nearest",
}


def reject_unsafe(code: str) -> None:
    tree = ast.parse(code, mode="exec")
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.With, ast.AsyncWith, ast.ClassDef)):
            raise ValueError(f"{type(node).__name__} is not allowed in strategy code.")
        if isinstance(node, ast.Name) and node.id in BANNED_NAMES:
            raise ValueError(f"{node.id} is not allowed in strategy code.")
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise ValueError("Dunder attribute access is not allowed.")


def extract_backtest_config(code: str) -> dict:
    tree = ast.parse(code, mode="exec")
    raw = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "BACKTEST" for target in node.targets):
            raw = ast.literal_eval(node.value)
            break
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "BACKTEST":
            raw = ast.literal_eval(node.value)
            break
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError("BACKTEST must be a literal dictionary.")
    config = {**DEFAULT_BACKTEST, **raw}
    timeframe = str(config.get("timeframe", "1m"))
    if timeframe not in {"1m", "15m", "4h", "1d"}:
        raise ValueError("BACKTEST timeframe must be 1m, 15m, 4h or 1d.")
    config["timeframe"] = timeframe
    config["sessions"] = min(250, max(1, int(config.get("sessions", 15))))
    for key in ("starting_capital_usd", "point_value", "risk_percent"):
        config[key] = float(config[key])
        if not math.isfinite(config[key]) or config[key] <= 0:
            raise ValueError(f"BACKTEST {key} must be greater than zero.")
    if config["risk_percent"] > 100:
        raise ValueError("BACKTEST risk_percent must be at most 100.")
    for key in ("spread_points", "slippage_points", "commission_hkd", "margin_per_contract"):
        config[key] = float(config.get(key, 0))
        if not math.isfinite(config[key]) or config[key] < 0:
            raise ValueError(f"BACKTEST {key} must be zero or greater.")
    config["execution_mode"] = str(config.get("execution_mode", "intrabar_ohlc")).lower()
    config["ambiguity_policy"] = str(config.get("ambiguity_policy", "nearest")).lower()
    if config["execution_mode"] not in {"next_bar_open", "current_bar_close", "intrabar_ohlc"}:
        raise ValueError("BACKTEST execution_mode is unsupported.")
    if config["ambiguity_policy"] not in {"worst_case", "best_case", "open_high_low_close", "open_low_high_close", "nearest"}:
        raise ValueError("BACKTEST ambiguity_policy is unsupported.")
    return config


def main() -> None:
    payload = json.load(sys.stdin)
    code = str(payload.get("code", ""))
    if not code.strip():
        raise ValueError("Strategy code is required.")
    reject_unsafe(code)
    backtest_config = extract_backtest_config(code)
    if payload.get("configOnly") is True:
        print(json.dumps({"ok": True, "config": backtest_config}, separators=(",", ":")))
        return
    bars = payload.get("bars", [])
    if not isinstance(bars, list) or len(bars) < 30:
        raise ValueError("Strategy code and at least 30 bars are required.")
    namespace = {"__builtins__": SAFE_BUILTINS, "math": math}
    exec(compile(code, "<strategy>", "exec"), namespace, namespace)
    strategy = namespace.get("strategy")
    if not callable(strategy):
        raise ValueError("Code must define strategy(bars).")
    result = strategy(bars)
    if isinstance(result, list):
        result = {"signals": result}
    if not isinstance(result, dict):
        raise ValueError("strategy(bars) must return a dict or a signal list.")
    engine_settings = dict(backtest_config)
    strategy_engine = result.get("engine", {})
    if isinstance(strategy_engine, dict):
        engine_settings.update(strategy_engine)
    runtime = payload.get("runtime", {}) if isinstance(payload.get("runtime"), dict) else {}
    usd_hkd = float(runtime.get("usd_hkd", 7.8))
    if not math.isfinite(usd_hkd) or usd_hkd <= 0:
        usd_hkd = 7.8
    engine_settings["initial_capital"] = backtest_config["starting_capital_usd"] * usd_hkd
    plots = result.get("plots", {})
    if not isinstance(plots, dict):
        plots = {}
    clean_plots = {}
    for name, values in list(plots.items())[:3]:
        if isinstance(values, list) and len(values) == len(bars):
            clean_plots[str(name)[:24]] = [float(value) if value is not None and math.isfinite(float(value)) else None for value in values]
    orders = normalize_orders(result, bars)
    backtest = BacktestEngine(bars, orders, engine_settings).run()
    print(json.dumps({"ok": True, **backtest, "plots": clean_plots, "config": backtest_config}, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, separators=(",", ":")))
        raise SystemExit(1)
