#!/usr/bin/env bash
set -euo pipefail

domain="${1:-turn.asynchronous-inc.org}"
source_dir="/etc/letsencrypt/live/${domain}"
target_dir="/etc/turnserver/certs"
turn_group="${TURN_GROUP:-turnserver}"

# Certbot runs every deploy hook for every renewed lineage. Ignore unrelated
# certificates (for example the WSS certificate) but allow manual invocation.
if [[ -n "${RENEWED_DOMAINS:-}" && " ${RENEWED_DOMAINS} " != *" ${domain} "* ]]; then
  exit 0
fi

if ! getent group "${turn_group}" >/dev/null; then
  echo "coturn group '${turn_group}' does not exist" >&2
  exit 1
fi
if [[ ! -r "${source_dir}/fullchain.pem" || ! -r "${source_dir}/privkey.pem" ]]; then
  echo "certificate for ${domain} is not available" >&2
  exit 1
fi

install -d -o root -g "${turn_group}" -m 0750 "${target_dir}"
install -o root -g "${turn_group}" -m 0640 \
  "${source_dir}/fullchain.pem" "${target_dir}/fullchain.pem"
install -o root -g "${turn_group}" -m 0640 \
  "${source_dir}/privkey.pem" "${target_dir}/privkey.pem"

# Restart only when coturn is already installed and enabled. This also makes
# renewed certificates effective without exposing Let's Encrypt's private
# archive directory to the turnserver account.
if systemctl cat coturn.service >/dev/null 2>&1; then
  systemctl try-restart coturn.service
fi
