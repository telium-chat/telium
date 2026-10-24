#!/usr/bin/env bash
#
# Fence the telium network in to the internet and itself.
#
# Docker already keeps one bridge network from talking to another, so the
# torrent stack next door is not reachable from here. Two holes it leaves open
# are the ones that matter for a tunnel:
#
#   - the host itself, reachable from a container at the bridge gateway
#     (172.31.240.1) and at the host's LAN address (192.168.128.156), which is
#     where sshd and every loopback-published port on this box actually live;
#   - the rest of the LAN, reachable because the bridge masquerades onto it.
#
# cloudflared takes its ingress rules from the Cloudflare account, not from any
# file here, so the only durable answer to "what can the tunnel reach if that
# account is abused" is a firewall. After this runs the honest answer is: the
# server container on 172.31.240.3, and the public internet. Which is the point
# -- the tunnel has to reach Cloudflare's edge to be a tunnel at all, and it
# cannot be given a route to anything of ours that it was not already given.
#
# Idempotent. Run it again whenever Docker has been restarted; the unit beside
# this file does that.

set -euo pipefail

NET=172.31.240.0/28

# `-I` puts a rule on top, so these read bottom-up: the RETURN for our own
# subnet is inserted last and therefore matched first.
private=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10)

# Anything routed *through* the host: the LAN, the other bridge networks, and
# the internet. DOCKER-USER is consulted before Docker's own rules and is the
# supported place to put this.
for cidr in "${private[@]}"; do
  iptables -C DOCKER-USER -s "$NET" -d "$cidr" -j DROP 2>/dev/null \
    || iptables -I DOCKER-USER -s "$NET" -d "$cidr" -j DROP
done

# 172.16/12 above contains our own subnet, so this has to sit above it.
iptables -C DOCKER-USER -s "$NET" -d "$NET" -j RETURN 2>/dev/null \
  || iptables -I DOCKER-USER -s "$NET" -d "$NET" -j RETURN

# Anything addressed *to* the host lands in INPUT rather than FORWARD, so the
# rules above never see it. Nothing on this network has a reason to talk to the
# host: no ports are published, and Docker's DNS resolver answers from inside
# the container's own namespace.
iptables -C INPUT -s "$NET" -j DROP 2>/dev/null \
  || iptables -I INPUT -s "$NET" -j DROP

echo "netguard: $NET fenced to itself and the internet"
