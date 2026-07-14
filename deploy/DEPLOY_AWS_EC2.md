# Deploy Relay signaling and TURN on AWS EC2

This is the production procedure for these endpoints:

- `wss://relay.asynchronous-inc.org` - WebSocket signaling through Nginx
- `turn.asynchronous-inc.org` - STUN/TURN directly through coturn

Signaling alone does not carry camera or microphone packets. A public STUN
server can establish a direct WebRTC route on many networks, but symmetric NAT,
carrier-grade NAT and restrictive firewalls require TURN. Without the coturn
part of this guide, a deployment can work on a LAN and fail across the internet.

## Assumptions and capacity

The commands below assume Ubuntu 24.04 LTS, one EC2 instance in a public subnet,
one Elastic IPv4 address, and the repository checked out directly at
`/opt/relay` (so the entry point is `/opt/relay/index.js`). Both DNS names may
point at the same Elastic IP.

A `t3.small` is a practical starting point for one broadcaster and a few
viewers. Direct peer-to-peer calls barely use the instance, but every TURN call
passes media into and back out of EC2. Monitor network throughput, CPU and AWS
data-transfer cost; move to `t3.medium` or a compute-optimized instance when
TURN traffic is sustained or concurrent viewer count grows.

This setup offers TURN/UDP, TURN/TCP and TURN/TLS on port 5349. A network that
allows only TLS on port 443 can still block it. Because Nginx already owns port
443 on this IP, universal enterprise fallback requires a second public IP or a
separate TURN instance serving `turns:` on 443.

## 1. Configure the EC2 network

The subnet route table must contain `0.0.0.0/0 -> Internet Gateway`, and the
instance must have an Elastic IP. Keep the default outbound security-group rule
that allows internet traffic. Add these inbound rules:

| Protocol | Port/range | Source | Purpose |
|---|---:|---|---|
| TCP | 22 | your administrator IP `/32` | SSH |
| TCP | 80 | `0.0.0.0/0` | ACME validation and HTTP redirect |
| TCP | 443 | `0.0.0.0/0` | HTTPS/WSS signaling |
| UDP | 3478 | `0.0.0.0/0` | preferred STUN/TURN transport |
| TCP | 3478 | `0.0.0.0/0` | TURN fallback |
| TCP | 5349 | `0.0.0.0/0` | TURN over TLS fallback |
| UDP | 49152-49251 | `0.0.0.0/0` | coturn media relay allocations |

The UDP relay range is not a bandwidth limit or WebSocket message limit. Each
TURN allocation needs a reachable UDP relay port. Keep this range identical in
the security group and `turnserver.conf`.

Do not expose TCP 8787 (the backend listens only on `127.0.0.1`) or coturn's
administrative CLI port 5766. If a custom network ACL is in use, it must also
permit the rules above and their return traffic; security groups themselves are
stateful.

## 2. Configure DNS

Create these `A` records using the Elastic IP:

```text
relay.asynchronous-inc.org  -> ELASTIC_IP
turn.asynchronous-inc.org   -> ELASTIC_IP
```

If the DNS provider is Cloudflare, set both records to **DNS only**. The normal
Cloudflare HTTP proxy does not forward TURN ports 3478, 5349 or the UDP relay
range. Do not create `AAAA` records unless IPv6 has also been configured in EC2
and coturn.

Verify before continuing:

```bash
dig +short A relay.asynchronous-inc.org
dig +short A turn.asynchronous-inc.org
```

Both commands must return the Elastic IP.

## 3. Update the application and install packages

The repository should be owned by the deployment account, not by `root` or the
service account. This avoids `.git/FETCH_HEAD: Permission denied` during pulls:

```bash
sudo chown -R ubuntu:ubuntu /opt/relay
cd /opt/relay
git pull origin master
npm ci --omit=dev
npm test

sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx coturn openssl
sudo systemctl disable --now coturn
getent passwd turnserver
```

The final command must show the unprivileged account installed by Ubuntu's
coturn package.

Create the signaling account if this is a new instance:

```bash
id relay >/dev/null 2>&1 || \
  sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin relay
```

## 4. Create the shared TURN secret and backend environment

coturn and the signaling backend must use exactly the same secret. The backend
uses it to issue one-hour credentials; the secret itself is never sent to an
Electron client or committed to Git.

```bash
TURN_SECRET="$(openssl rand -hex 32)"
sudo install -d -o root -g relay -m 0750 /etc/relay
printf '%s\n' \
  'NODE_ENV=production' \
  'HOST=127.0.0.1' \
  'PORT=8787' \
  'TURN_HOST=turn.asynchronous-inc.org' \
  "TURN_SECRET=${TURN_SECRET}" \
  'TURN_TTL=3600' \
  | sudo tee /etc/relay/relay.env >/dev/null
sudo chown root:relay /etc/relay/relay.env
sudo chmod 0640 /etc/relay/relay.env
```

Do not put this value in a client build, Nginx file or public `.env`. The
deployed `relay.service` reads `/etc/relay/relay.env` directly.

## 5. Issue and safely install the TURN TLS certificate

Nginx serves only the HTTP-01 challenge for the TURN name. TURN traffic itself
does not go through Nginx.

On a fresh instance, first install the signaling virtual host and certificate.
If `wss://relay.asynchronous-inc.org` is already healthy, leave its existing
Nginx configuration in place and skip this block:

```bash
cd /opt/relay
sed 's/relay\.example\.com/relay.asynchronous-inc.org/g' \
  deploy/nginx-relay.conf \
  | sudo tee /etc/nginx/sites-available/relay >/dev/null
sudo ln -sfn /etc/nginx/sites-available/relay \
  /etc/nginx/sites-enabled/relay
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d relay.asynchronous-inc.org \
  --agree-tos --no-eff-email --email YOUR_REAL_EMAIL_ADDRESS
curl -fsS https://relay.asynchronous-inc.org/
```

The last command can fail until the relay service is installed in step 7; a
valid TLS response or Nginx `502 Bad Gateway` still proves DNS and TLS are in
place.

```bash
cd /opt/relay
sudo install -d -m 0755 /var/www/certbot/.well-known/acme-challenge
sudo install -m 0644 deploy/nginx-turn-acme.conf \
  /etc/nginx/sites-available/turn-acme
sudo ln -sfn /etc/nginx/sites-available/turn-acme \
  /etc/nginx/sites-enabled/turn-acme
sudo nginx -t
sudo systemctl reload nginx

sudo certbot certonly --webroot -w /var/www/certbot \
  -d turn.asynchronous-inc.org --agree-tos --no-eff-email \
  --email YOUR_REAL_EMAIL_ADDRESS
```

Do not make `/etc/letsencrypt` world-readable. Install the supplied deploy hook,
which copies only this certificate into a directory readable by coturn:

```bash
sudo install -m 0755 deploy/install-turn-certificate.sh \
  /usr/local/sbin/install-turn-certificate
sudo install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
sudo ln -sfn /usr/local/sbin/install-turn-certificate \
  /etc/letsencrypt/renewal-hooks/deploy/relay-turn-certificate
sudo /usr/local/sbin/install-turn-certificate
```

## 6. Render and start coturn

EC2 exposes a private address on its network interface and maps the Elastic IP
to it. coturn must be told both addresses or it will advertise an unreachable
private relay candidate. These commands use IMDSv2 to discover the mapping:

```bash
IMDS_TOKEN="$(curl -fsS -X PUT \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600' \
  http://169.254.169.254/latest/api/token)"
PRIVATE_IP="$(curl -fsS \
  -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" \
  http://169.254.169.254/latest/meta-data/local-ipv4)"
PUBLIC_IP="$(curl -fsS \
  -H "X-aws-ec2-metadata-token: ${IMDS_TOKEN}" \
  http://169.254.169.254/latest/meta-data/public-ipv4)"
TURN_SECRET="$(sudo sed -n 's/^TURN_SECRET=//p' /etc/relay/relay.env)"

test -n "${PRIVATE_IP}" && test -n "${PUBLIC_IP}" && test -n "${TURN_SECRET}"
sed \
  -e "s/__PRIVATE_IPV4__/${PRIVATE_IP}/g" \
  -e "s/__PUBLIC_IPV4__/${PUBLIC_IP}/g" \
  -e "s/__TURN_SHARED_SECRET__/${TURN_SECRET}/g" \
  /opt/relay/deploy/turnserver.conf.template \
  | sudo tee /etc/turnserver.conf >/dev/null
unset TURN_SECRET IMDS_TOKEN

sudo chown root:turnserver /etc/turnserver.conf
sudo chmod 0640 /etc/turnserver.conf

# Ubuntu ships this legacy gate alongside the systemd unit. Enable it
# explicitly so a package upgrade cannot leave coturn disabled.
sudo sed -i '/^[#[:space:]]*TURNSERVER_ENABLED=/d' /etc/default/coturn
echo 'TURNSERVER_ENABLED=1' | sudo tee -a /etc/default/coturn >/dev/null
sudo systemctl enable --now coturn
sudo systemctl status coturn --no-pager
sudo journalctl -u coturn -n 100 --no-pager
```

The log must not contain certificate, private-key, listener-bind or
`external-ip` errors.

## 7. Install and restart the signaling service

```bash
cd /opt/relay
sudo install -m 0644 deploy/relay.service /etc/systemd/system/relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now relay
sudo systemctl restart relay
sudo systemctl status relay --no-pager
curl -fsS http://127.0.0.1:8787/
curl -fsS http://127.0.0.1:8787/ | grep -q '"turnConfigured":true'
```

The first health response must include `"ok":true` and
`"turnConfigured":true`; the second command exits nonzero if TURN credential
issuance was not loaded. Check startup details with:

```bash
sudo journalctl -u relay -n 100 --no-pager
```

After a broadcaster is authenticated or a viewer joins a valid session, the
backend sends a short-lived `ice-servers` configuration. Rejected and otherwise
unattached WebSocket connections receive no TURN credentials. The client uses
direct ICE where possible and automatically uses coturn when direct candidates
cannot connect.

## 8. Verify from outside the EC2 network

Check listeners on EC2:

```bash
sudo ss -lntup | grep -E ':3478|:5349|:8787|:443'
```

Expected results are coturn on UDP/TCP 3478 and TCP 5349, Nginx on TCP 443, and
Node only on `127.0.0.1:8787`.

From a different internet connection, verify STUN and TLS:

```bash
turnutils_stunclient turn.asynchronous-inc.org
echo | openssl s_client -connect turn.asynchronous-inc.org:5349 \
  -servername turn.asynchronous-inc.org 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

Then run the current Electron build on two genuinely different networks (for
example home broadband and a phone hotspot). In Chromium's
`chrome://webrtc-internals`, the selected candidate pair should show candidate
type `relay` whenever a direct route is unavailable. During that test,
`journalctl -u coturn -f` should show an authenticated allocation.

An HTTPS/WSS health check proves signaling only. It does **not** prove that UDP
3478 or the relay range is reachable.

## 9. Renewals and application updates

Certbot's systemd timer renews the certificate and the deploy hook restarts
coturn with the copied key:

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

For a backend update:

```bash
sudo chown -R ubuntu:ubuntu /opt/relay
cd /opt/relay
git pull origin master
npm ci --omit=dev
npm test
sudo systemctl restart relay
sudo systemctl status relay --no-pager
```

Do not overwrite `/etc/relay/relay.env` during normal deployments. Rotating
`TURN_SECRET` requires changing both `/etc/relay/relay.env` and
`static-auth-secret` in `/etc/turnserver.conf`, followed by restarting both
services. Existing allocations may be interrupted, so rotate it in a maintenance
window.
