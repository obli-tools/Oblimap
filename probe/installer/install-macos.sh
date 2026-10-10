#!/bin/bash
# Oblimap Probe Installer for macOS (Intel + Apple Silicon)
#
# Recommended usage (key pre-injected by server):
#   sudo bash -c "$(curl -fsSL 'https://your-server/api/probe/installer/macos?key=<apikey>')"
#
# Manual usage:
#   sudo bash install-macos.sh --url https://your-server --key <apikey>

set -e

# Values injected by the server. Single-quoted literals: nothing inside is
# ever expanded by the shell.
SERVER_URL='__SERVER_URL__'
API_KEY='__API_KEY__'
CONFIG_DIR="/etc/oblimap-probe"
CONFIG_FILE="$CONFIG_DIR/config.json"

# Placeholder sentinels, built so that server-side substitution never
# rewrites them.
URL_PLACEHOLDER="__SERVER""_URL__"
KEY_PLACEHOLDER="__API""_KEY__"

# ── Parse optional override args ──────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --url)   SERVER_URL="$2"; shift 2 ;;
    --url=*) SERVER_URL="${1#*=}"; shift ;;
    --key)   API_KEY="$2"; shift 2 ;;
    --key=*) API_KEY="${1#*=}"; shift ;;
    *) shift ;;
  esac
done

if [ -z "$SERVER_URL" ] || [ "$SERVER_URL" = "$URL_PLACEHOLDER" ]; then
  echo "Error: Server URL not set."
  echo "Use the URL provided in the Oblimap admin panel, or pass --url <serverUrl>."
  exit 1
fi
if [ -z "$API_KEY" ] || [ "$API_KEY" = "$KEY_PLACEHOLDER" ]; then
  echo "Error: API key not set."
  echo "Use the URL provided in the Oblimap admin panel, or pass --key <apiKey>."
  exit 1
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

# ── Require root ──────────────────────────────────────────────────────────────

if [ "$EUID" -ne 0 ]; then
  echo "Error: This installer requires administrator privileges."
  echo ""
  echo "Please re-run the installation command with sudo, e.g.:"
  echo "  sudo bash install-macos.sh --url '${SERVER_URL}' --key <your-api-key>"
  exit 1
fi

echo "=============================="
echo " Oblimap Probe Installer"
echo " macOS"
echo "=============================="
echo "Server : $SERVER_URL"
echo ""

# ── 1. Detect architecture ────────────────────────────────────────────────────

ARCH=$(uname -m)
case "$ARCH" in
  arm64)  BINARY_SUFFIX="darwin-arm64"  ;;   # Apple Silicon (M1/M2/M3/M4)
  x86_64) BINARY_SUFFIX="darwin-amd64"  ;;   # Intel Mac
  *)
    echo "Unsupported architecture: $ARCH (supported: arm64, x86_64)"
    exit 1
    ;;
esac

echo "[1/4] Architecture: $ARCH → oblimap-probe-${BINARY_SUFFIX}"

# ── 2. Download probe binary ──────────────────────────────────────────────────

# Private, randomly named 0700 directory in sticky /tmp (never a fixed path
# that another local user could pre-create, and not $TMPDIR, which may be a
# directory owned by the invoking user).
TMP_DIR=$(mktemp -d /tmp/oblimap-probe-install.XXXXXX)
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_BINARY="$TMP_DIR/oblimap-probe"

echo "[2/4] Downloading binary..."
curl -fsSL "${SERVER_URL}/api/probe/download/oblimap-probe-${BINARY_SUFFIX}" \
  -o "$TMP_BINARY"
chmod 700 "$TMP_BINARY"

# ── 3. Write config ───────────────────────────────────────────────────────────

# The key goes to a root-only config file, never to a command line (visible
# to every local user in `ps`) or to the launchd plist.
echo "[3/4] Writing configuration..."
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

EXTRA_LINES=""
if [ -n "$DEVICE_UUID" ]; then
  EXTRA_LINES="$EXTRA_LINES,
  \"deviceUuid\": \"$DEVICE_UUID\""
fi
if [ -n "$PROBE_TOKEN" ]; then
  EXTRA_LINES="$EXTRA_LINES,
  \"probeToken\": \"$PROBE_TOKEN\""
fi
if [ -n "$DEVICE_CHECKS" ]; then
  EXTRA_LINES="$EXTRA_LINES,
  \"deviceChecks\": $DEVICE_CHECKS"
fi

cat > "$CONFIG_FILE" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "apiKey": "$API_KEY",
  "scanIntervalSeconds": 300$EXTRA_LINES
}
EOF
chmod 600 "$CONFIG_FILE"
umask 022

# ── 4. Install (binary copies itself, registers launchd service) ─────────────

echo "[4/4] Installing service..."

# The binary's "install" subcommand reads /etc/oblimap-probe/config.json and:
#   - Copies itself to /usr/local/bin/oblimap-probe
#   - Writes /Library/LaunchDaemons/com.oblimap.probe.plist (no arguments)
#   - Runs: launchctl load <plist>
# (The device UUID is resolved from the hardware on first start.)
"$TMP_BINARY" -install

# The temp directory is removed by the EXIT trap (the binary already copied
# itself to /usr/local/bin/).

echo ""
echo "=============================="
echo " Installation complete!"
echo ""
echo " The probe is now running and"
echo " will appear in the Oblimap"
echo " admin panel once approved."
echo ""
echo " To uninstall:"
echo "   sudo oblimap-probe -uninstall"
echo "=============================="
