"""Observe the existing loopback PostgreSQL listener; never start Steampipe."""
import os
import signal
import ssl
import sys

import pg8000.native

HEALTH_DEADLINE_SECONDS = 5


def check_health():
    password = os.environ.get("STEAMPIPE_DATABASE_PASSWORD")
    if not password:
        return 1
    connection = None
    try:
        # The embedded listener uses its private self-signed certificate.
        tls = ssl.create_default_context()
        tls.check_hostname = False
        tls.verify_mode = ssl.CERT_NONE
        connection = pg8000.native.Connection(
            host="127.0.0.1", port=9193, database="steampipe", user="steampipe",
            password=password, ssl_context=tls, timeout=2,
        )
        return 0 if connection.run("SELECT 1") == [[1]] else 1
    except Exception:
        return 1  # Never emit password, connection details, or provider errors.
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


def main():
    signal.signal(signal.SIGALRM, lambda *_: sys.exit(1))
    signal.alarm(HEALTH_DEADLINE_SECONDS)
    try:
        return check_health()
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
