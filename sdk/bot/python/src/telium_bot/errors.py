"""Errors and the predicates that classify them."""

from __future__ import annotations

from typing import Any

BOT_NOT_INSTALLED_CODE = "bot_not_installed"
UNKNOWN_BOT_TOKEN_CODE = "unknown_bot_token"
BOT_CREDENTIAL_REVOKED_CODE = "bot_credential_revoked"

# Statuses that mean "not allowed in"; retried.
AUTH_STATUSES = frozenset({401, 403, 407})


class TeliumError(Exception):
    """Base class for SDK errors."""


class HttpError(TeliumError):
    """A non-2xx response. ``status`` and the decoded JSON ``body`` are kept."""

    def __init__(self, message: str, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class RequestTimeout(TeliumError):
    """A request exceeded its per-attempt timeout."""


class DiscoveryError(TeliumError):
    """Discovery refused or failed; never retried over a weaker transport."""


def error_code(error: BaseException) -> str:
    body = getattr(error, "body", None)
    if isinstance(body, dict):
        for key in ("code", "error"):
            value = body.get(key)
            if isinstance(value, str) and value:
                return value.lower()
    return ""


def _status(error: BaseException) -> int | None:
    status = getattr(error, "status", None)
    try:
        return int(status)
    except (TypeError, ValueError):
        return None


def is_dead_credential(error: BaseException) -> bool:
    if _status(error) != 401:
        return False
    return error_code(error) in (UNKNOWN_BOT_TOKEN_CODE, BOT_CREDENTIAL_REVOKED_CODE)


def is_not_installed(error: BaseException) -> bool:
    if _status(error) != 403:
        return False
    code = error_code(error)
    if code == BOT_NOT_INSTALLED_CODE:
        return True
    # "forbidden" is generic, so it alone earns a look at the sentence.
    if code and code != "forbidden":
        return False
    body = getattr(error, "body", None)
    message = (body.get("message") if isinstance(body, dict) else None) or str(error)
    return "not installed on this guild server" in str(message).lower()


def is_auth_error(error: BaseException) -> bool:
    return _status(error) in AUTH_STATUSES


def is_terminal_http_error(error: BaseException) -> bool:
    status = _status(error)
    if status is None or status < 400 or status >= 500:
        return False
    if status in (408, 429):
        return False
    if is_dead_credential(error):
        return True
    if status in AUTH_STATUSES:
        return False
    return True
