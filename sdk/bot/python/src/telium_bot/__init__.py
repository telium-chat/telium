"""First-party Telium bot client for Python."""

from .client import AUTH_RETRY_LIMIT, BotClient, Context
from .discovery import INSECURE_HTTP_ENV, Discovered, discover
from .errors import (
    BOT_CREDENTIAL_REVOKED_CODE, BOT_NOT_INSTALLED_CODE, UNKNOWN_BOT_TOKEN_CODE,
    DiscoveryError, HttpError, RequestTimeout, TeliumError,
    is_auth_error, is_dead_credential, is_not_installed, is_terminal_http_error,
)

__version__ = "0.2.0"

__all__ = [
    "AUTH_RETRY_LIMIT", "BOT_CREDENTIAL_REVOKED_CODE", "BOT_NOT_INSTALLED_CODE", "BotClient", "Context",
    "Discovered", "DiscoveryError", "HttpError", "INSECURE_HTTP_ENV", "RequestTimeout", "TeliumError",
    "UNKNOWN_BOT_TOKEN_CODE", "discover", "is_auth_error", "is_dead_credential", "is_not_installed",
    "is_terminal_http_error",
]
