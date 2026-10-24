# Security policy

## Reporting a vulnerability

Please do not publish an exploitable security issue in a normal public issue.

Use GitHub's **Report a vulnerability** / private vulnerability reporting flow for this repository when it is available. If that control is not available to you, contact a repository owner privately and include:

- the affected Telium component and version/commit;
- reproduction steps or a minimal proof of concept;
- the security impact you believe is possible;
- whether the issue has been disclosed anywhere else.

Please avoid accessing data that is not yours, disrupting a server, or testing against third-party Telium servers without permission.

## What we consider security-sensitive

Examples include authentication or session bypass, device/cross-signing failures, federation signature verification problems, unauthorized guild administration, media capability bypasses, remote code execution, stored or reflected script injection, and cryptographic failures that expose message contents.

## Supported versions

Telium is pre-1.0 and currently supports the latest release line. Security fixes may require upgrading rather than backporting to older development snapshots.

## Coordinated disclosure

The maintainers will use the private report to reproduce and classify the issue, prepare a fix, and coordinate disclosure. Please keep technical exploitation details private until a fix or mitigation is available.
