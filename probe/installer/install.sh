#!/bin/bash
# Oblimap Probe Installer for Linux
# Usage: curl -fsSL "https://your-server/api/probe/installer/linux?key=<apikey>" | bash
# Or:    bash install.sh --url https://your-server --key <apikey>

set -e

# Values injected by the server. Single-quoted literals: nothing inside is
# ever expanded by the shell.
SERVER_URL='__SERVER_URL__'
API_KEY='__API_KEY__'
INSTALL_DIR="/opt/oblimap-probe"
SERVICE_NAME="oblimap-probe"
BINARY_NAME="oblimap-probe"
CONFIG_DIR="/etc/oblimap-probe"
CONFIG_FILE="$CONFIG_DIR/config.json"

# Placeholder sentinels, built so that server-side substitution never
# rewrites them.
URL_PLACEHOLDER="__SERVER""_URL__"
KEY_PLACEHOLDER="__API""_KEY__"

# Parse args (override injected values)
while [ $# -gt 0 ]; do
  case "$1" in
    --url=*) SERVER_URL="${1#*=}"; shift ;;
    --key=*) API_KEY="${1#*=}"; shift ;;
    --url)   SERVER_URL="$2"; shift 2 ;;
    --key)   API_KEY="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$SERVER_URL" ] || [ "$SERVER_URL" = "$URL_PLACEHOLDER" ]; then
  echo "Error: --url is required"; exit 1
fi
if [ -z "$API_KEY" ] || [ "$API_KEY" = "$KEY_PLACEHOLDER" ]; then
  echo "Error: --key is required"; exit 1
fi

# The API key is a UUID (^[0-9a-fA-F-]{36}$); refuse anything else.
case "$API_KEY" in
  *[!0-9a-fA-F-]*) echo "Error: invalid API key format"; exit 1 ;;
esac
if [ "${#API_KEY}" -ne 36 ]; then
  echo "Error: invalid API key format"; exit 1
fi

# The server URL must be http(s) and only contain URL characters (it is
# written to the JSON config and used in download URLs). \133 and \135 are
# "[" and "]" (IPv6 literal hosts such as http://[fd00::1]:3001).
case "$SERVER_URL" in
  http://*|https://*) ;;
  *) echo "Error: invalid server URL (must start with http:// or https://)"; exit 1 ;;
esac
if [ "$(printf '%s!' "$SERVER_URL" | tr -d 'A-Za-z0-9._~:/?#@%+=,;&\133\135-')" != "!" ]; then
  echo "Error: invalid characters in server URL"; exit 1
fi

echo "=============================="
echo " Oblimap Probe Installer"
echo "=============================="
echo "Server URL : $SERVER_URL"
echo "Install dir: $INSTALL_DIR"
echo ""

# ── 1. Detect architecture ────────────────────────────────────────────────────

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  BINARY_SUFFIX="linux-amd64" ;;
  aarch64) BINARY_SUFFIX="linux-arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH (supported: x86_64, aarch64)"
    exit 1
    ;;
esac

echo "[1/4] Architecture: $ARCH"

# ── 2. Download binary ────────────────────────────────────────────────────────

echo "[2/4] Downloading probe binary..."
mkdir -p "$INSTALL_DIR"
curl -fsSL "${SERVER_URL}/api/probe/download/oblimap-probe-${BINARY_SUFFIX}" \
  -o "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

# ── 3. Write config ───────────────────────────────────────────────────────────

echo "[3/4] Writing configuration..."

# The config holds the tenant API key and the probe identity token:
# root-only directory (0700) and file (0600).
umask 077
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

# On a reinstall, keep the device UUID and the identity token issued by the
# server (without it, the server would reject this probe until an admin
# resets its token), and the operator's local "deviceChecks" policy (written
# by hand, never by the server: dropping it would silently lift it).
DEVICE_UUID=""
PROBE_TOKEN=""
DEVICE_CHECKS=""
if [ -f "$CONFIG_FILE" ]; then
  DEVICE_UUID=$(sed -n 's|.*"deviceUuid"[[:space:]]*:[[:space:]]*"\([0-9A-Fa-f-]*\)".*|\1|p' "$CONFIG_FILE" | head -n 1)
  PROBE_TOKEN=$(sed -n 's|.*"probeToken"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._-]*\)".*|\1|p' "$CONFIG_FILE" | head -n 1)
  if grep -q '"deviceChecks"' "$CONFIG_FILE"; then
    # The "deviceChecks" object as it is (balanced braces; its values are
    # booleans, numbers and a list of ports).
    DEVICE_CHECKS=$(awk '
      { buf = buf $0 "\n" }
      END {
        i = index(buf, "\"deviceChecks\"")
        if (i == 0) exit
        s = substr(buf, i + 14)
        if (!match(s, /^[ \t\r\n]*:[ \t\r\n]*[{]/)) exit
        s = substr(s, RLENGTH)
        depth = 0
        for (k = 1; k <= length(s); k++) {
          c = substr(s, k, 1)
          if (c == "{") depth++
          else if (c == "}") { depth--; if (depth == 0) { print substr(s, 1, k); exit } }
        }
      }' "$CONFIG_FILE")
    if [ -z "$DEVICE_CHECKS" ]; then
      cp -p "$CONFIG_FILE" "$CONFIG_FILE.bak"
      echo "  WARNING: the local \"deviceChecks\" policy of $CONFIG_FILE could not be carried over."
      echo "           The previous file is kept as $CONFIG_FILE.bak: merge it back by hand."
    fi
  fi
fi

if [ -z "$DEVICE_UUID" ]; then
  DEVICE_UUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || \
                python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || \
                cat /dev/urandom | tr -dc 'a-f0-9' | head -c 32 | \
                sed 's/\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\)/\1-\2-\3-\4-\5/')
fi

TOKEN_LINE=""
if [ -n "$PROBE_TOKEN" ]; then
  TOKEN_LINE=",
  \"probeToken\": \"$PROBE_TOKEN\""
fi
if [ -n "$DEVICE_CHECKS" ]; then
  TOKEN_LINE="$TOKEN_LINE,
  \"deviceChecks\": $DEVICE_CHECKS"
fi

cat > "$CONFIG_FILE" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "apiKey": "$API_KEY",
  "deviceUuid": "$DEVICE_UUID",
  "scanIntervalSeconds": 300$TOKEN_LINE
}
EOF
chmod 600 "$CONFIG_FILE"
umask 022

# ── 4. Install systemd service ────────────────────────────────────────────────

echo "[4/4] Installing service..."

if command -v systemctl &>/dev/null; then
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Oblimap Network Probe
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
Restart=always
RestartSec=10
User=root
ExecStart=$INSTALL_DIR/$BINARY_NAME
StandardOutput=append:/var/log/oblimap-probe.log
StandardError=append:/var/log/oblimap-probe.log
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"

  echo ""
  systemctl status "$SERVICE_NAME" --no-pager -l || true

elif [ -d /etc/init.d ]; then
  cat > "/etc/init.d/${SERVICE_NAME}" <<INITEOF
#!/bin/bash
# chkconfig: 2345 80 20
DAEMON="$INSTALL_DIR/$BINARY_NAME"
PIDFILE=/var/run/${SERVICE_NAME}.pid
case "\$1" in
  start)   \$DAEMON & echo \$! > \$PIDFILE; echo "Started" ;;
  stop)    kill \$(cat \$PIDFILE) 2>/dev/null; rm -f \$PIDFILE; echo "Stopped" ;;
  restart) \$0 stop; \$0 start ;;
  status)  [ -f \$PIDFILE ] && kill -0 \$(cat \$PIDFILE) 2>/dev/null && echo "Running" || echo "Stopped" ;;
esac
INITEOF
  chmod +x "/etc/init.d/${SERVICE_NAME}"
  chkconfig --add "$SERVICE_NAME" 2>/dev/null || true
  service "$SERVICE_NAME" start

else
  echo "No service manager found. Start manually:"
  echo "  $INSTALL_DIR/$BINARY_NAME &"
fi

echo ""
echo "=============================="
echo " Installation complete!"
echo " The probe will appear in"
echo " the Oblimap admin panel"
echo " once approved."
echo "=============================="
