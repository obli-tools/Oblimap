# Oblimap

**Self-hosted IPAM and network discovery, driven by lightweight probes.**

Oblimap discovers and tracks every device on your networks (IP, MAC, vendor, type, open ports and history) through push-based probes that need no inbound port. It is built for MSPs and network administrators who manage many sites and want an up-to-date inventory, IP conflict alerts and remote access to LAN devices.

Website: [map.obli.tools](https://map.obli.tools)

## Key features

- **Network discovery by probes**: subnet scans with TCP, ping and ARP, reverse DNS and optional port scans.
- **Device tracking**: devices are identified by MAC address across IP changes, with an event history and a page per device.
- **Alerts**: IP takeover / conflict and instability detection; vendor lookup from the IEEE registry and automatic classification by vendor and open ports.
- **Subnets and reservations**: VLAN and gateway metadata, utilisation, next free IP and a subnet heatmap.
- **Device checks**: HTTP checks run by the probes against discovered devices, with presets and business-hours alerting.
- **Tunnels through probes**: open the web interface of a LAN device, or a TCP tunnel to it, straight from the panel.
- **Network flow map**: visualise TCP flows between devices.
- **Settings inheritance and maintenance windows** across global, group, site and probe levels, with 10 notification channels.
- **Access and privacy**: multi-tenancy, teams, permission sets, step-up 2FA for sensitive actions, audit log and an anonymous mode that masks IPs, MACs and names.
- **Fleet and data**: paced probe updates, JSON import/export and CSV import.

## Quick install

```sh
curl -fsSL https://raw.githubusercontent.com/obli-tools/Oblimap/main/install.sh | sh
```

The installer runs on Linux, or on macOS with Docker Desktop. It:

- checks Docker and Docker Compose; on Linux it offers to install them with Docker's official script, only after you confirm;
- downloads `docker-compose.yml` and `.env.example` into `./oblimap`;
- creates `.env` with unique random secrets (`DB_PASSWORD`, `SESSION_SECRET`, `DATA_ENCRYPTION_KEY`, initial admin password);
- pulls the images, starts the stack and prints the panel URL and the initial admin password (shown only once).

Running it again upgrades an existing install; `.env` is never modified.

Options (pass them after `sh -s --`):

| Option | Description |
|--------|-------------|
| `-y`, `--yes` | Non-interactive: accept the defaults and install Docker if it is missing |
| `--dir PATH` | Install directory (default `./oblimap`) |
| `--port PORT` | Host port of the web interface (default `3002`, first install only) |
| `--url URL` | Public URL of the panel, e.g. `https://oblimap.example.com` (first install only) |

```sh
curl -fsSL https://raw.githubusercontent.com/obli-tools/Oblimap/main/install.sh | sh -s -- -y --dir /opt/oblimap --url https://oblimap.example.com
```

`--help` lists every option.

## Manual install (Docker Compose)

```sh
mkdir oblimap && cd oblimap
curl -fsSLO https://raw.githubusercontent.com/obli-tools/Oblimap/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/obli-tools/Oblimap/main/.env.example
cp .env.example .env
mkdir -p custom
# Edit .env: set DB_PASSWORD, SESSION_SECRET (32+ characters), DATA_ENCRYPTION_KEY
# (e.g. openssl rand -base64 32), DEFAULT_ADMIN_PASSWORD and CLIENT_ORIGIN
# (the public URL of the panel, reachable by the probes).
docker compose up -d
```

The panel answers on port `3002` (`LISTEN_PORT`). The stack runs PostgreSQL 16, the server (`meejay/oblimap-server`) and the web client (`meejay/oblimap-client`). To use an existing PostgreSQL server instead, see `docker-compose.external-db.yml`.

`DATA_ENCRYPTION_KEY` encrypts secrets stored in the database: back it up with the database, losing it makes them unreadable.

## Update

```sh
docker compose pull && docker compose up -d
```

Or run the installer again from the same directory.

## Installing probes

Probes are installed from the panel (**Add probe**): an install command for Linux, macOS and FreeBSD, an MSI for Windows, and a container image for Docker / MikroTik RouterOS v7. New probes wait for approval.

## Requirements

- A Linux host (or macOS with Docker Desktop) with Docker Engine and Docker Compose v2.
- Probes use `CLIENT_ORIGIN` as the server address: it must be reachable by them (not `localhost`).
- HTTPS through a reverse proxy for production use: set `CLIENT_ORIGIN` to the public `https://` address, `FORCE_HTTPS=true` and `TRUSTED_PROXY_HOPS=2` in `.env`, then run `docker compose up -d` again.

## Single sign-on

Oblimap supports single sign-on with [Obligate](https://github.com/obli-tools/Obligate): register Oblimap as an app in Obligate, then enter the Obligate URL and API key in the Oblimap settings. Local accounts keep working alongside SSO.

## Part of the Obli suite

| Tool | Purpose |
|------|---------|
| [Obliance](https://ance.obli.tools) | Remote monitoring and management (RMM) |
| [Oblireach](https://reach.obli.tools) | Remote screen access and remote support |
| [Obliview](https://view.obli.tools) | Uptime and infrastructure monitoring |
| **[Oblimap](https://map.obli.tools)** | IPAM and network discovery |
| [Obliguard](https://guard.obli.tools) | Agent-based intrusion prevention |
| [Obligate](https://gate.obli.tools) | Single sign-on and access management for the suite |
| [Oblihub](https://hub.obli.tools) | Docker control panel |
| [Obliwan](https://github.com/obli-tools/Obliwan) | WAN router fleet management |
| [ObliDesk](https://github.com/obli-tools/ObliDesk) | Ticketing and service desk |
| [Obliplan](https://github.com/obli-tools/Obliplan) | Workforce scheduling and working-time tracking |
| [Oblifield](https://field.obli.tools) | Field intervention management |

Suite home: [obli.tools](https://obli.tools)

## License

Oblimap is source-available under the [Elastic License 2.0](LICENSE) (ELv2). You may use, modify and self-host it, including for commercial use inside your organization; you may not provide it to others as a hosted or managed service. See [LICENSE](LICENSE) for the full terms and the obli.tools clarifications.
