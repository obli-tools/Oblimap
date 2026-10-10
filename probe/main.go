package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ProbeVersion is the current version of the probe binary.
// This is overridden at build time: -ldflags "-X main.ProbeVersion=1.0.0"
var ProbeVersion = "1.0.0"

// Config holds the probe configuration persisted to disk.
type Config struct {
	ServerURL           string `json:"serverUrl"`
	APIKey              string `json:"apiKey"`
	DeviceUUID          string `json:"deviceUuid"`
	ScanIntervalSeconds int    `json:"scanIntervalSeconds"`
	BackoffUntil        int64  `json:"backoffUntil"` // unix ms
	FlowAnalysisEnabled bool   `json:"flowAnalysisEnabled"`
	// IdentityV2: DeviceUUID is the shared Obli* device ID acknowledged by
	// the server (device_identity.go). Until then DeviceUUID is the legacy
	// hardware-derived UUID, re-resolved at every start.
	IdentityV2 bool `json:"identityV2,omitempty"`
	// ProbeToken is the per-probe identity secret issued by the server (trust
	// on first use). Once issued, the server requires it alongside the API key.
	// Never logged.
	ProbeToken string `json:"probeToken,omitempty"`
	// DeviceChecks is the operator's local device checks policy (it can only
	// tighten the compiled limits, see checks_policy.go). Only ever read from
	// disk: the server never writes it (saveConfig preserves it as loaded).
	DeviceChecks *LocalChecksPolicy `json:"deviceChecks,omitempty"`
}

const defaultScanInterval = 300

// rescanFloor is the wait before the scan triggered by a "rescan" command in
// HTTP polling mode (instead of the full scan interval).
const rescanFloor = 5 * time.Second

// maxRescanStreak caps the immediate rescans in a row. Over HTTP the server
// clears pending_command when it delivers it, so a "rescan" following an
// immediate rescan is a new admin request and is honoured; the cap only
// protects against a misbehaving server repeating the command on every push.
const maxRescanStreak = 3

// httpLoopDelay returns how long the HTTP polling loop waits before its next
// scan, and the updated count of immediate rescans in a row. interval is the
// value doPush returned (< 30 s falls back to the default). rescan is the
// consumed rescanRequested flag. After maxRescanStreak immediate rescans in a
// row the full interval applies once, so a server repeating "rescan" on every
// push never hot-loops.
func httpLoopDelay(interval int, rescan bool, streak int) (time.Duration, int) {
	if rescan && streak < maxRescanStreak {
		return rescanFloor, streak + 1
	}
	if interval < 30 {
		interval = defaultScanInterval
	}
	return time.Duration(interval) * time.Second, 0
}

// probeFeatures is advertised in the X-Probe-Features header. "token" tells
// the server this probe can receive and persist a per-probe identity token.
const probeFeatures = "token"

var (
	configPath string
	cfg        Config

	// cfgMu serialises saveConfig and guards cfg.ProbeToken, which is read by
	// every request goroutine and written by the WS reader / HTTP push.
	cfgMu sync.Mutex
)

// configDirOverride replaces the platform config directory when set (tests
// only: they must never write the real installation's config.json).
var configDirOverride string

func configDir() string {
	if configDirOverride != "" {
		return configDirOverride
	}
	switch runtime.GOOS {
	case "windows":
		d := os.Getenv("ProgramData")
		if d == "" {
			d = `C:\ProgramData`
		}
		return filepath.Join(d, "OblimapProbe")
	default:
		return "/etc/oblimap-probe"
	}
}

func loadConfig() {
	configPath = filepath.Join(configDir(), "config.json")
	data, err := os.ReadFile(configPath)
	if err == nil {
		if err2 := json.Unmarshal(data, &cfg); err2 != nil {
			log.Printf("WARN: could not parse config: %v", err2)
		}
	}
	if cfg.ScanIntervalSeconds == 0 {
		cfg.ScanIntervalSeconds = defaultScanInterval
	}
	// Restore cached flow analysis setting from persisted config
	scanCfgMu.Lock()
	cachedFlowAnalysisEnabled = cfg.FlowAnalysisEnabled
	scanCfgMu.Unlock()
}

// saveConfig persists cfg atomically (temp file in the same directory, then
// rename) with owner-only permissions. The config holds the tenant API key and
// the per-probe identity token, so it must never be readable by other users.
// Returns true when the file was written.
func saveConfig() bool {
	return saveConfigWith(nil)
}

// saveConfigWith persists cfg with mutate applied, and applies mutate to the
// in-memory cfg only once the file has been written. cfgMu is held throughout,
// so no other goroutine can observe a value (the identity token) that is not
// on disk yet.
func saveConfigWith(mutate func(*Config)) bool {
	cfgMu.Lock()
	defer cfgMu.Unlock()

	// Sync cached settings into config struct before persisting
	cfg.FlowAnalysisEnabled = flowAnalysisEnabled()

	next := cfg
	if mutate != nil {
		mutate(&next)
	}

	dir := configDir()
	if configPath == "" {
		configPath = filepath.Join(dir, "config.json")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Printf("WARN: could not create config dir: %v", err)
		return false
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		log.Printf("WARN: could not encode config: %v", err)
		return false
	}

	if err := writeConfigAtomic(dir, data); err != nil {
		log.Printf("WARN: atomic config save failed (%v) — writing in place", err)
		if err2 := os.WriteFile(configPath, data, 0600); err2 != nil {
			log.Printf("WARN: could not save config: %v", err2)
			return false
		}
	}
	// Tighten files created by older versions or installers (0644 / 0640).
	if err := os.Chmod(configPath, 0600); err != nil {
		log.Printf("WARN: could not restrict config permissions: %v", err)
	}
	if mutate != nil {
		mutate(&cfg)
	}
	return true
}

// writeConfigAtomic writes data to a fresh temp file (mode 0600) in dir and
// renames it over configPath.
func writeConfigAtomic(dir string, data []byte) error {
	tmp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0600); err != nil && runtime.GOOS != "windows" {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, configPath); err != nil {
		return err
	}
	ok = true
	return nil
}

// ─── Probe identity token ────────────────────────────────────────────────────

// probeTokenRe bounds what the probe accepts as an identity token: it is sent
// back verbatim in an HTTP header and written to config.json (the installers
// preserve it on reinstall with the same character class).
var probeTokenRe = regexp.MustCompile(`^[A-Za-z0-9._-]{16,256}$`)

// currentProbeToken returns the identity token, or "" when none was issued yet.
func currentProbeToken() string {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	return cfg.ProbeToken
}

// storeProbeToken records a token issued by the server and persists it.
// Returns true when the token is (now) stored on disk. The token is written
// to disk before it becomes visible to setProbeAuthHeaders, and a token that
// cannot be persisted is dropped rather than used: the server binds a token
// the first time the probe presents it, and a token lost at the next restart
// would lock the probe out. The token itself is never logged.
func storeProbeToken(token string) bool {
	if token == "" {
		return false
	}
	if !probeTokenRe.MatchString(token) {
		log.Printf("WARN: ignoring malformed probe identity token received from server")
		return false
	}
	if currentProbeToken() == token {
		return true
	}

	log.Printf("Probe identity token received from server — storing it in the config file")
	if !saveConfigWith(func(c *Config) { c.ProbeToken = token }) {
		log.Printf("ERROR: could not persist the probe identity token — not using it (the server issues a new one on a later contact)")
		return false
	}
	return true
}

// setProbeAuthHeaders adds the probe authentication headers to an outgoing
// request (HTTP push, update notification, control and tunnel WebSockets).
// advertiseFeatures adds X-Probe-Features. It is left off only for throw-away
// connections (the startup WebSocket capability test): the server may issue an
// identity token to a push or control WebSocket advertising the feature, and a
// token sent on a connection the probe closes unread would be lost.
func setProbeAuthHeaders(h http.Header, advertiseFeatures bool) {
	h.Set("X-API-Key", cfg.APIKey)
	h.Set("X-Probe-UUID", currentDeviceUUID())
	if advertiseFeatures {
		h.Set("X-Probe-Features", probeFeatures)
	}
	if token := currentProbeToken(); token != "" {
		h.Set("X-Probe-Token", token)
	}
}

// startupUpdateCheckNeeded tells whether the unauthenticated startup check
// (GET /api/probe/version) runs. A probe advertising updatePolicyCapability
// skips it: the server's update policy (auto / manual / frozen) reaches it
// through the latestVersion of the authenticated channel only (the first
// push follows right after the startup), so a 'frozen' or 'manual' scope is
// never updated behind the policy's back. Probes built before the capability
// keep the startup check (documented residual behaviour on the server side).
func startupUpdateCheckNeeded(caps []string) bool {
	for _, c := range caps {
		if c == updatePolicyCapability {
			return false
		}
	}
	return true
}

// checkForUpdate calls GET /api/probe/version at startup and applies any
// available update immediately — before entering the main scan loop — unless
// the probe follows the server's update policy (startupUpdateCheckNeeded).
// During normal operation the server also piggybacks the latest version on
// push responses / config_update (handled in push.go and ws.go).
func checkForUpdate() {
	if !startupUpdateCheckNeeded(probeCapabilities()) {
		log.Printf("Auto-update: startup check skipped (the server announces updates per its update policy)")
		return
	}
	type versionResponse struct {
		Version string `json:"version"`
	}
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(cfg.ServerURL + "/api/probe/version")
	if err != nil {
		log.Printf("Auto-update: startup version check failed: %v", err)
		return
	}
	defer resp.Body.Close()
	var info versionResponse
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil || info.Version == "" {
		return
	}
	if isStrictlyNewer(info.Version, ProbeVersion) {
		log.Printf("Auto-update: new version %s available at startup, applying...", info.Version)
		applyUpdate(info.Version)
	}
}

func mainLoop() {
	// Device identity v2 (device_identity.go): the shared Obli* device ID once
	// the server acknowledged it, else the legacy hardware-derived UUID —
	// re-resolved on every start by resolveDeviceUUID (unchanged), so a server
	// without v2 keeps seeing the same ID. Code reads the ID through
	// currentDeviceUUID() only; cfg.DeviceUUID is just what config.json holds.
	setupDeviceIdentity()
	log.Printf("Oblimap Probe %s starting (UUID: %s)", ProbeVersion, currentDeviceUUID())

	// Check for a newer version before entering the scan loop.
	checkForUpdate()

	// Device checks run independently of the transport: create the manager
	// and the result reporter before the first push, so the assignment that
	// push returns is applied in WS and HTTP modes alike.
	ctx := context.Background()
	checkMgr = newCheckManager(ctx)
	checkRep = newCheckReporter(checkMgr)
	go checkRep.run(ctx)
	if p := localChecksPolicy(); p != nil && p.Enabled != nil && !*p.Enabled {
		log.Printf("Device checks are disabled by the local policy (config.json deviceChecks.enabled=false)")
	}

	// Try WebSocket persistent connection first.
	// The probe must be registered via HTTP first (wsAvailable checks this).
	// Do one HTTP push to ensure registration, then switch to WS.
	log.Printf("Performing initial HTTP push for registration...")
	doPush()

	if wsAvailable() {
		log.Printf("Switching to WebSocket persistent connection")
		wsMainLoop() // Blocks, reconnects internally. Only returns on unrecoverable error.
		log.Printf("WebSocket loop exited, falling back to HTTP polling")
	}

	// HTTP polling fallback
	log.Printf("Using HTTP polling mode")
	httpPollingMode.Store(true) // device check results go to POST /api/probe/check-results
	// A "rescan" received by the startup push (or before a WS session) is
	// already covered: the first iteration below scans immediately.
	rescanRequested.Store(false)
	rescanStreak := 0
	for {
		if cfg.BackoffUntil > 0 && time.Now().UnixMilli() < cfg.BackoffUntil {
			wait := time.Until(time.UnixMilli(cfg.BackoffUntil))
			log.Printf("Backing off for %v", wait.Round(time.Second))
			time.Sleep(wait)
		}

		interval := doPush()

		var wait time.Duration
		wait, rescanStreak = httpLoopDelay(interval, rescanRequested.Swap(false), rescanStreak)
		log.Printf("Next scan in %ds", int(wait.Seconds()))
		time.Sleep(wait)
	}
}

func main() {
	var (
		serverURL = flag.String("server", "", "Oblimap server URL (e.g. https://oblimap.example.com)")
		apiKey    = flag.String("key", "", "API key (from Oblimap admin → Probes → API Keys)")
		install   = flag.Bool("install", false, "Install as system service")
		uninstall = flag.Bool("uninstall", false, "Uninstall system service")
		version   = flag.Bool("version", false, "Print version and exit")
	)
	flag.Parse()

	// Container installs (MikroTik) pass the server URL / API key in the
	// environment: the key stays out of the process list. Flags win.
	if *serverURL == "" {
		*serverURL = strings.TrimSpace(os.Getenv("OBLIMAP_SERVER"))
	}
	if *apiKey == "" {
		*apiKey = strings.TrimSpace(os.Getenv("OBLIMAP_KEY"))
	}

	if *version {
		fmt.Printf("Oblimap Probe v%s (%s/%s)\n", ProbeVersion, runtime.GOOS, runtime.GOARCH)
		return
	}

	loadConfig()

	// Restrict the config directory / file to root or SYSTEM + Administrators
	// (they hold the API key and identity token). Never fatal.
	ensureConfigPerms()

	if *serverURL != "" {
		cfg.ServerURL = *serverURL
		saveConfig()
	}
	if *apiKey != "" {
		cfg.APIKey = *apiKey
		saveConfig()
	}

	if cfg.ServerURL == "" || cfg.APIKey == "" {
		fmt.Fprintf(os.Stderr, "Error: --server and --key are required on first run.\n")
		fmt.Fprintf(os.Stderr, "Example: oblimap-probe --server https://oblimap.example.com --key <your-api-key>\n")
		os.Exit(1)
	}

	if *install {
		if err := serviceInstall(); err != nil {
			fmt.Fprintf(os.Stderr, "Install error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Service installed and started.")
		return
	}

	if *uninstall {
		if err := serviceUninstall(); err != nil {
			fmt.Fprintf(os.Stderr, "Uninstall error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Service uninstalled.")
		return
	}

	// Run as service if launched by SCM, else run interactively
	runAsService(mainLoop)
}
