# Caddy with the DuckDNS DNS provider module.
#
# The stock Caddy image does not include third-party DNS providers, and the
# DuckDNS module is required for the ACME DNS-01 challenge (see Caddyfile).
# DNS-01 needs no inbound port 80/443 from the internet — only outbound access
# to DuckDNS and Let's Encrypt — so this works for LAN-only servers.

FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/duckdns

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
