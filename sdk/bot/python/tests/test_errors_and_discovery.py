import pytest

from telium_bot import (
    DiscoveryError, HttpError, discover, is_auth_error, is_dead_credential, is_not_installed,
    is_terminal_http_error,
)
from telium_bot.discovery import parse_txt_pointer, public_address, require_gateway_url


def err(status, body=None):
    return HttpError("x", status=status, body=body)


def test_not_installed_by_code_and_by_sentence():
    assert is_not_installed(err(403, {"code": "bot_not_installed"}))
    assert is_not_installed(err(403, {"code": "forbidden", "message": "Bot is not installed on this guild server"}))
    assert not is_not_installed(err(403, {"code": "other"}))
    assert not is_not_installed(err(401, {"code": "bot_not_installed"}))


def test_classification():
    assert is_dead_credential(err(401, {"code": "unknown_bot_token"}))
    assert not is_dead_credential(err(401, {"code": "clock_skew"}))
    assert is_auth_error(err(403)) and is_auth_error(err(401))
    assert is_terminal_http_error(err(400)) and is_terminal_http_error(err(404))
    assert not is_terminal_http_error(err(429)) and not is_terminal_http_error(err(503))
    assert not is_terminal_http_error(err(403))
    assert is_terminal_http_error(err(401, {"code": "bot_credential_revoked"}))


def test_public_address():
    assert public_address("93.184.216.34")
    for ip in ("127.0.0.1", "10.1.2.3", "192.168.0.1", "::1", "fe80::1", "::ffff:127.0.0.1"):
        assert not public_address(ip)


def test_txt_pointer_stays_under_account_domain():
    assert parse_txt_pointer("telium.example.com\n", "example.com") == "https://telium.example.com"
    for bad in ("evil.test", "https://telium.example.com:8443", "https://example.com/path", "a\nb"):
        with pytest.raises(DiscoveryError):
            parse_txt_pointer(bad, "example.com")


def test_gateway_must_be_tls_and_in_delegation():
    assert require_gateway_url("wss://gw.example.com/x", "example.com") == "wss://gw.example.com/x"
    with pytest.raises(DiscoveryError):
        require_gateway_url("ws://gw.example.com", "example.com", allow_insecure_http=False)
    with pytest.raises(DiscoveryError):
        require_gateway_url("wss://evil.test", "example.com")
    assert require_gateway_url("ws://example.com", "example.com", allow_insecure_http=True) == "ws://example.com"


async def test_plain_domain_never_falls_back_to_http():
    seen = []

    async def fake(url):
        seen.append(url)
        raise OSError("down")

    with pytest.raises(OSError):
        await discover("bots.example", allow_insecure_http=False, direct_get_json=fake)
    assert seen == ["https://bots.example/.well-known/telium/server"]


async def test_discovery_refuses_other_origin_and_wrong_name():
    async def other_api(url):
        return {"server_name": "bots.example", "api": "https://evil.test", "gateway": "wss://bots.example/g"}

    with pytest.raises(DiscoveryError):
        await discover("bots.example", allow_insecure_http=False, direct_get_json=other_api)

    async def wrong_name(url):
        return {"server_name": "someone.else", "api": "https://bots.example"}

    with pytest.raises(DiscoveryError):
        await discover("bots.example", allow_insecure_http=False, direct_get_json=wrong_name)


async def test_discovery_ok():
    async def good(url):
        return {"server_name": "Bots.Example", "api": "https://api.bots.example/", "gateway": "wss://gw.bots.example/v1"}

    found = await discover("bots.example", allow_insecure_http=False, direct_get_json=good)
    assert (found.domain, found.api, found.gateway) == ("bots.example", "https://api.bots.example", "wss://gw.bots.example/v1")


async def test_txt_fallback_pointer_and_claim():
    async def not_found(url):
        raise HttpError("nf", status=404)

    async def text(url):
        return "telium.bots.example"

    async def doc(url):
        assert url == "https://telium.bots.example/.well-known/telium/server"
        return {"server_name": "bots.example", "api": "https://telium.bots.example", "gateway": "wss://telium.bots.example/g"}

    found = await discover("bots.example", allow_insecure_http=False,
                           direct_get_json=not_found, txt_get_text=text, txt_get_json=doc)
    assert found.api == "https://telium.bots.example"
