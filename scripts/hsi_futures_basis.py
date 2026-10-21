"""Translate cash reference levels using simultaneous completed provider bars."""
import math


def matched_basis(futures, cash, now):
    for time in sorted(set(futures) & set(cash), reverse=True):
        # Futu timestamps label bar end; exclude bars not yet completed.
        if time > now:
            continue
        future_close, cash_close = futures[time]['close'], cash[time]['close']
        if not all(math.isfinite(v) and v > 0 for v in (future_close, cash_close)):
            continue
        return dict(points=round(future_close - cash_close, 6), time=time,
                    futuresClose=future_close, cashClose=cash_close,
                    futuresSymbol='HK.HSImain', cashSymbol='HK.800000',
                    method='matched_15m_close', source='Futu OpenD')
    return None
