//! Outbound HTTP for federation discovery under an address policy.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use anyhow::{bail, Result};
use serde_json::Value;
use url::Url;

const TOTAL_TIMEOUT: Duration = Duration::from_secs(6);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

pub const MAX_DOCUMENT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressPolicy {
    Untrusted,
    OperatorConfigured,
}

impl AddressPolicy {
    fn allows_plaintext(self) -> bool {
        matches!(self, Self::OperatorConfigured)
    }

    fn allows_private_addresses(self) -> bool {
        matches!(self, Self::OperatorConfigured)
    }
}

pub fn is_forbidden_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_v4(v4),
        IpAddr::V6(v6) => is_forbidden_v6(v6),
    }
}

fn is_forbidden_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || ip.is_unspecified()
        // 100.64.0.0/10, carrier-grade NAT. `Ipv4Addr::is_shared` is unstable.
        || (a == 100 && (64..=127).contains(&b))
        || ip.octets()[..3] == [192, 0, 0]
        || (a == 198 && (b == 18 || b == 19))
        || a >= 240
}

fn is_forbidden_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();

    // Refused whole: `to_ipv4` maps `::1` to the harmless-looking 0.0.0.1.
    if segments[..6] == [0, 0, 0, 0, 0, 0] {
        return true;
    }

    // An IPv4 address in an IPv6 costume (`::ffff:127.0.0.1`) is still that IPv4 address.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_forbidden_v4(v4);
    }

    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // fc00::/7, unique local. `is_unique_local` is unstable.
        || (segments[0] & 0xfe00) == 0xfc00
        // fe80::/10, link local. `is_unicast_link_local` is unstable.
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2002
            && is_forbidden_v4(Ipv4Addr::new(
                (segments[1] >> 8) as u8,
                (segments[1] & 0xff) as u8,
                (segments[2] >> 8) as u8,
                (segments[2] & 0xff) as u8,
            )))
        || (segments[0] == 0x2001 && segments[1] == 0x0000)
        || (segments[0] == 0x0100 && segments[1] == 0 && segments[2] == 0 && segments[3] == 0)
        // NAT64: the low 32 bits are a real IPv4 destination.
        || (segments[0] == 0x0064
            && segments[1] == 0xff9b
            && is_forbidden_v4(Ipv4Addr::new(
                (segments[6] >> 8) as u8,
                (segments[6] & 0xff) as u8,
                (segments[7] >> 8) as u8,
                (segments[7] & 0xff) as u8,
            )))
}

/// Parse a claimed `server_name` (host[:port], not a URL) into a dialable `(host, port)`.
pub fn parse_authority(origin: &str) -> Option<(String, Option<u16>)> {
    if origin.is_empty() || origin.len() > 255 {
        return None;
    }
    if origin
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '/' | '?' | '#' | '@' | '\\' | '%'))
    {
        return None;
    }

    let (host, port) = if let Some(rest) = origin.strip_prefix('[') {
        let close = rest.find(']')?;
        let host = &rest[..close];
        let tail = &rest[close + 1..];
        host.parse::<Ipv6Addr>().ok()?;
        let port = match tail {
            "" => None,
            t => Some(t.strip_prefix(':')?.parse::<u16>().ok()?),
        };
        (format!("[{host}]"), port)
    } else {
        let mut parts = origin.split(':');
        let host = parts.next()?;
        let port = match parts.next() {
            None => None,
            Some(p) => Some(p.parse::<u16>().ok()?),
        };
        if parts.next().is_some() {
            return None;
        }
        (host.to_string(), port)
    };

    // Trailing dot stripped: discovery compares the returned name to the asked one.
    if !host.starts_with('[') {
        let bare = host.trim_end_matches('.');
        if bare.is_empty() || bare.len() > 253 {
            return None;
        }
        let labels_ok = bare.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        });
        if !labels_ok {
            return None;
        }
        return Some((bare.to_string(), port));
    }

    Some((host, port))
}

/// Every resolved address is checked: mixed public/private is a race attempt.
async fn vet_destination(url: &Url, policy: AddressPolicy) -> Result<SocketAddr> {
    let host = match url.host_str() {
        Some(h) => h,
        None => bail!("discovery URL has no host"),
    };
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow::anyhow!("discovery URL has no port"))?;

    let addrs: Vec<SocketAddr> = if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| anyhow::anyhow!("could not resolve {host}: {e}"))?
            .collect()
    };

    if addrs.is_empty() {
        bail!("{host} resolved to no addresses");
    }
    if !policy.allows_private_addresses() {
        for addr in &addrs {
            if is_forbidden_address(addr.ip()) {
                bail!("{host} resolves to a non-public address and will not be fetched");
            }
        }
    }
    Ok(addrs[0])
}

pub async fn get_json(url: &str, policy: AddressPolicy, max_bytes: usize) -> Result<Value> {
    let parsed = Url::parse(url)?;
    match parsed.scheme() {
        "https" => {}
        "http" if policy.allows_plaintext() => {}
        // Plaintext for an untrusted origin is a downgrade; TLS binds the keys to the domain.
        other => bail!("refusing to fetch discovery over {other}"),
    }

    let addr = vet_destination(&parsed, policy).await?;
    let host = parsed.host_str().unwrap_or_default().to_string();

    let mut builder = reqwest::Client::builder()
        .timeout(TOTAL_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        // A discovery document does not redirect; the peer is the party we are constraining.
        .redirect(reqwest::redirect::Policy::none());

    // Pin the vetted address, or reqwest re-resolves and DNS rebinding wins.
    if !host.is_empty() && host.parse::<IpAddr>().is_err() {
        builder = builder.resolve(&host, addr);
    }

    let resp = builder.build()?.get(parsed.clone()).send().await?.error_for_status()?;

    // Stream with a cap rather than `.json()`, which buffers whatever the peer sends.
    let mut body: Vec<u8> = Vec::new();
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await? {
        if body.len() + chunk.len() > max_bytes {
            bail!("discovery document exceeded {max_bytes} bytes");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&body)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_policy_refuses_non_public_ranges() {
        for raw in [
            "127.0.0.1", "0.0.0.0", "10.0.0.7", "172.16.4.1", "192.168.1.1", "169.254.169.254",
            "100.64.0.1", "198.18.0.1", "224.0.0.1", "240.0.0.1", "::1", "fd12::1", "fe80::1",
            "ff02::1", "::ffff:169.254.169.254", "2002:7f00:1::", "2001:0:1234::",
            "64:ff9b::7f00:1", "::127.0.0.1",
        ] {
            assert!(is_forbidden_address(raw.parse().unwrap()), "{raw} must be refused");
        }
        for raw in ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "64:ff9b::8080:808"] {
            assert!(!is_forbidden_address(raw.parse().unwrap()), "{raw} must be allowed");
        }
    }

    #[test]
    fn server_name_parsing_refuses_url_smuggling() {
        for origin in [
            "evil.test/", "evil.test?x=", "evil.test#", "real.test@evil.test", "evil.test\\@real.test",
            "evil.test:8080:9090", "https://evil.test", "evil.test\r\nHost: x", "ev%69l.test", "",
            "::1", "evil..test",
        ] {
            assert!(parse_authority(origin).is_none(), "{origin:?} must not parse");
        }
        assert_eq!(parse_authority("chat.example.com:8443"), Some(("chat.example.com".into(), Some(8443))));
        assert_eq!(parse_authority("chat.example.com."), Some(("chat.example.com".into(), None)));
        assert_eq!(parse_authority("[::1]:7890"), Some(("[::1]".into(), Some(7890))));
    }

    #[tokio::test]
    async fn untrusted_fetch_policy_is_enforced_before_connecting() {
        let err = |u: &'static str, p| async move { get_json(u, p, 1024).await.unwrap_err().to_string() };
        assert!(err("http://example.test/x", AddressPolicy::Untrusted).await.contains("over http"));
        for url in ["https://localhost:9/x", "https://169.254.169.254/x", "https://[::1]:9/x"] {
            assert!(err(url, AddressPolicy::Untrusted).await.contains("non-public address"), "{url}");
        }
        let e = err("http://127.0.0.1:9/x", AddressPolicy::OperatorConfigured).await;
        assert!(!e.contains("non-public address") && !e.contains("refusing to fetch"), "{e}");
    }
}
