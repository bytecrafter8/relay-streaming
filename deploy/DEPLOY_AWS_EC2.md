# Deploy Relay signaling to AWS EC2 with Nginx and WSS

This procedure targets Ubuntu 24.04 LTS and uses `relay.example.com` as a placeholder. Replace it with your actual subdomain everywhere.

## 1. Prepare AWS and DNS

Create an EC2 instance with an Elastic IP. A small instance is sufficient because signaling carries JSON only; WebRTC media remains peer-to-peer.

Configure the EC2 security group:

| Port | Source | Purpose |
|---|---|---|
| TCP 22 | Your public IP `/32` only | SSH administration |
| TCP 80 | `0.0.0.0/0` and optionally `::/0` | Certificate validation and HTTPS redirect |
| TCP 443 | `0.0.0.0/0` and optionally `::/0` | Secure WebSocket clients |

Do **not** expose TCP 8787. Nginx reaches it through `127.0.0.1`.

At your DNS provider, create an `A` record:

```text
relay.example.com -> EC2 Elastic IP
```

Wait until `dig +short relay.example.com` returns the Elastic IP.

## 2. Install runtime packages

SSH to the instance, then install Node.js 20+, Nginx, and Certbot. The following uses Ubuntu's Node package; use NodeSource if Ubuntu provides a Node version below 20.

```bash
sudo apt update
sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx
node --version
```

## 3. Upload the backend

From your development machine:

```bash
scp -r backend ubuntu@EC2_IP:/tmp/relay-backend
```

On EC2:

```bash
sudo useradd --system --home /opt/relay --shell /usr/sbin/nologin relay
sudo mkdir -p /opt/relay
sudo mv /tmp/relay-backend /opt/relay/backend
sudo chown -R relay:relay /opt/relay
cd /opt/relay/backend
sudo -u relay npm ci --omit=dev
```

## 4. Install the systemd service

```bash
sudo cp /opt/relay/backend/deploy/relay.service /etc/systemd/system/relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now relay
sudo systemctl status relay --no-pager
curl http://127.0.0.1:8787/
```

The final command must return JSON containing `"ok":true`.

View service logs with:

```bash
sudo journalctl -u relay -f
```

## 5. Configure Nginx

Replace the placeholder domain and install the configuration:

```bash
sudo sed 's/relay\.example\.com/relay.YOURDOMAIN.com/g' \
  /opt/relay/backend/deploy/nginx-relay.conf \
  | sudo tee /etc/nginx/sites-available/relay >/dev/null
sudo ln -s /etc/nginx/sites-available/relay /etc/nginx/sites-enabled/relay
sudo nginx -t
sudo systemctl reload nginx
```

If `/etc/nginx/sites-enabled/default` conflicts with your setup, remove only that symlink and reload Nginx.

Verify plain HTTP before requesting TLS:

```bash
curl http://relay.YOURDOMAIN.com/
```

## 6. Enable TLS and WSS

```bash
sudo certbot --nginx -d relay.YOURDOMAIN.com
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

Certbot updates Nginx for HTTPS and normally installs automatic renewal through a systemd timer.

Your Electron clients should use:

```text
wss://relay.YOURDOMAIN.com
```

Do not append port 8787.

## 7. Verify WebSocket access

First verify HTTPS health:

```bash
curl https://relay.YOURDOMAIN.com/
```

Then enter `wss://relay.YOURDOMAIN.com` in Relay Settings and select **Test connection**.

Useful diagnostics:

```bash
sudo systemctl status relay nginx --no-pager
sudo journalctl -u relay -n 100 --no-pager
sudo tail -n 100 /var/log/nginx/error.log
sudo ss -lntp | grep -E ':80|:443|:8787'
```

Port 8787 should show only `127.0.0.1:8787`.

## 8. Deploy updates

Upload a new backend directory, then on EC2:

```bash
cd /opt/relay/backend
sudo -u relay npm ci --omit=dev
sudo systemctl restart relay
sudo systemctl status relay --no-pager
```

Restarting the signaling process clears its in-memory session registry. Connected peers will reconnect, but broadcasters must recreate their hosted session. Persistent/multi-instance sessions require a shared store such as Redis.

## Production notes

- This backend is signaling only. It does not relay camera or audio.
- Add a TURN service for peers behind restrictive NAT or firewalls; public STUN alone is not sufficient for every network.
- Keep SSH restricted to your IP and do not expose port 8787.
- For horizontal scaling, move sessions and peer routing to Redis and configure sticky WebSocket routing or a shared pub/sub layer.
