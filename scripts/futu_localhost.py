LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def require_opend_localhost(host: str | None = None) -> str:
    value = (host or "127.0.0.1").strip()
    if value not in LOOPBACK_HOSTS:
        raise SystemExit(f"Refusing Futu OpenD host {value}; OpenD must listen on localhost.")
    return value
