package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// ─── Push payload types ───────────────────────────────────────────────────────

type OSInfo struct {
	Platform string `json:"platform"`
	Release  string `json:"release,omitempty"`
	Arch     string `json:"arch"`
}

type DiscoveredDevice struct {
	IP             string `json:"ip"`
	MAC            string `json:"mac,omitempty"`
	Hostname       string `json:"hostname,omitempty"`
	ResponseTimeMs *int64 `json:"responseTimeMs,omitempty"`
	IsOnline       bool   `json:"isOnline"`
	OpenPorts      []int  `json:"openPorts,omitempty"`
}

type PushBody struct {
	Hostname          string             `json:"hostname"`
	ProbeVersion      string             `json:"probeVersion"`
	OSInfo            OSInfo             `json:"osInfo"`
	ProbeMac          string             `json:"probeMac,omitempty"`
	ProbeIPs          []string           `json:"probeIPs,omitempty"`
	DiscoveredDevices []DiscoveredDevice `json:"discoveredDevices"`
	DiscoveredFlows   []FlowEntry        `json:"discoveredFlows,omitempty"`
	ScannedSubnets    []string           `json:"scannedSubnets"`
	ScanDurationMs    int64              `json:"scanDurationMs"`
	// Capabilities lists the optional protocol features this probe supports
	// (see probeCapabilities); older servers ignore it.
	Capabilities []string `json:"capabilities"`
	// ServerScheme is the scheme of the configured server URL ("http" or
	// "https"): the server delivers device check credentials only to probes
	// reaching it over https.
	ServerScheme string `json:"serverScheme,omitempty"`
	// SkippedSubnets lists the subnets (partly) left out of this scan and
	// why. Sent only to a server that advertised acceptsSkippedSubnets in its
	// last config (older servers may reject an unknown field): nil otherwise,
	// so the payload stays byte-identical to what older probes send.
	SkippedSubnets []SkippedSubnet `json:"skippedSubnets,omitempty"`
}

// SkippedSubnet is a subnet the scan left out, entirely or partly
// (reason "too_wide": only its /24 blocks with known hosts were scanned).
type SkippedSubnet struct {
	CIDR   string `json:"cidr"`
	Reason string `json:"reason"`
}

// maxReportedSkippedSubnets is the most skipped subnets one push reports
// (the server accepts at most 64).
const maxReportedSkippedSubnets = 64

type ProbeResponseConfig struct {
	ScanIntervalSeconds int      `json:"scanIntervalSeconds"`
	ExcludedSubnets     []string `json:"excludedSubnets"`
	ExtraSubnets        []string `json:"extraSubnets"`
	PortScanEnabled     bool     `json:"portScanEnabled"`
	PortScanPorts       []int    `json:"portScanPorts"`
	FlowAnalysisEnabled bool     `json:"flowAnalysisEnabled"`
	// DeviceChecks is this probe's device check assignment. Absent (old
	// server, capability not advertised) or empty stops every check.
	DeviceChecks *DeviceChecksConfig `json:"deviceChecks,omitempty"`
	// AcceptsSkippedSubnets: the server takes skippedSubnets in the push
	// body / scan_result (absent from older servers).
	AcceptsSkippedSubnets bool `json:"acceptsSkippedSubnets,omitempty"`
}

const (
	// updatePolicyCapability: this probe updates itself only on the
	// latestVersion carried by the authenticated channel (push response, WS
	// hello reply / config_update) — the server leaves it out for scopes whose
	// update policy is not 'auto' — and skips the unauthenticated startup
	// GET /api/probe/version check (see startupUpdateCheckNeeded).
	updatePolicyCapability = "update_policy:1"
	// updateAbortHTTPCapability: an aborted update is reported over HTTP
	// (POST /api/probe/agent/update-aborted) when no control WS is open.
	updateAbortHTTPCapability = "update_abort_http:1"
)

// probeCapabilities returns the capability list advertised in the push body
// and in the WebSocket hello. The plaintext-secrets capability reflects the
// local policy: the server sends check credentials over plain http only to a
// probe that advertises it (and would otherwise discard them).
func probeCapabilities() []string {
	caps := []string{deviceChecksCapability, tunnelHTTPCapability, updatePolicyCapability, updateAbortHTTPCapability}
	if local := localChecksPolicy(); local != nil && local.AllowPlaintextSecrets {
		caps = append(caps, deviceChecksPlaintextSecretsCapability)
	}
	if routerOSEnabled() {
		caps = append(caps, routerOSCapability)
	}
	return caps
}

type PushResponse struct {
	Status        string              `json:"status"`
	Config        ProbeResponseConfig `json:"config"`
	LatestVersion string              `json:"latestVersion,omitempty"`
	Command       string              `json:"command,omitempty"`
	// ProbeToken is set once, when the server issues this probe's identity
	// token (only to probes advertising X-Probe-Features: token).
	ProbeToken string `json:"probeToken,omitempty"`
}

// backoff levels in minutes
var backoffLevels = []time.Duration{5 * time.Minute, 10 * time.Minute, 30 * time.Minute, 60 * time.Minute}
var backoffIdx = 0

func hostname() string {
	h, _ := os.Hostname()
	if h == "" {
		h = "unknown"
	}
	return h
}

func osInfo() OSInfo {
	return OSInfo{
		Platform: runtime.GOOS,
		Arch:     runtime.GOARCH,
	}
}

// probeMac returns the MAC address of the network interface used to reach the
// configured server. It dials a UDP "connection" (no packets sent) to the
// server host to let the OS pick the outbound interface, then finds the
// interface whose IPv4 address matches the chosen local address.
func probeMac() string {
	// Extract host from ServerURL (e.g. "https://example.com:3002" → "example.com:80")
	dialHost := "8.8.8.8:80"
	if cfg.ServerURL != "" {
		if u, err := url.Parse(cfg.ServerURL); err == nil && u.Hostname() != "" {
			port := u.Port()
			if port == "" {
				if u.Scheme == "https" {
					port = "443"
				} else {
					port = "80"
				}
			}
			dialHost = u.Hostname() + ":" + port
		}
	}

	conn, err := dialOutboundUDP4(dialHost)
	if err != nil {
		return ""
	}
	localAddr := conn.LocalAddr().(*net.UDPAddr).IP
	conn.Close()

	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip != nil && ip.Equal(localAddr) {
				if len(iface.HardwareAddr) > 0 {
					return normalizeMacGo(iface.HardwareAddr.String())
				}
			}
		}
	}
	return ""
}

// probeLocalIP returns the local IPv4 address of the outbound interface
// (same interface that probeMac identifies).
func probeLocalIP() string {
	dialHost := "8.8.8.8:80"
	if cfg.ServerURL != "" {
		if u, err := url.Parse(cfg.ServerURL); err == nil && u.Hostname() != "" {
			port := u.Port()
			if port == "" {
				if u.Scheme == "https" {
					port = "443"
				} else {
					port = "80"
				}
			}
			dialHost = u.Hostname() + ":" + port
		}
	}

	conn, err := dialOutboundUDP4(dialHost)
	if err != nil {
		return ""
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String()
}

// dialOutboundUDP4 opens a UDP "connection" (no packet is sent) to learn the
// outbound IPv4 interface. IPv4 only: on a dual-stack LAN a server name with
// an AAAA record would otherwise yield an IPv6 self-address, which the server
// drops from the device list. Falls back to the default IPv4 route.
func dialOutboundUDP4(dialHost string) (net.Conn, error) {
	conn, err := net.Dial("udp4", dialHost)
	if err != nil && dialHost != "8.8.8.8:80" {
		conn, err = net.Dial("udp4", "8.8.8.8:80")
	}
	return conn, err
}

// probeLocalIPs returns ALL private IPv4 addresses on the machine, across all
// non-loopback, non-virtual, up interfaces. This allows the server to track
// multi-homed probes and match them to devices on multiple subnets.
func probeLocalIPs() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}

	var ips []string
	seen := make(map[string]bool)

	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		if isVirtualInterface(iface.Name) {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}

		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil {
				continue
			}
			ip4 := ip.To4()
			if ip4 == nil {
				continue // skip IPv6
			}
			ipStr := ip4.String()
			if seen[ipStr] {
				continue
			}
			if !isPrivateIPv4(ipStr) {
				continue
			}
			seen[ipStr] = true
			ips = append(ips, ipStr)
		}
	}

	return ips
}

// normalizeMacGo converts a MAC from Go's default "aa:bb:cc:dd:ee:ff" to
// uppercase "AA:BB:CC:DD:EE:FF" to match the server's normalization.
func normalizeMacGo(mac string) string {
	result := make([]byte, len(mac))
	for i, b := range []byte(mac) {
		if b >= 'a' && b <= 'f' {
			result[i] = b - 32
		} else {
			result[i] = b
		}
	}
	return string(result)
}

// doScan performs a full network scan and returns the PushBody payload.
// This is shared between doPush() (HTTP) and wsMainLoop() (WebSocket).
func doScan() PushBody {
	scanMu.Lock()
	defer scanMu.Unlock()

	scanStart := time.Now()

	// Snapshot the server's extra subnets for discoverSubnets (see cachedExtra).
	scanCfgMu.RLock()
	cachedExtra = serverExtraSubnets
	scanCfgMu.RUnlock()

	subnets, localNets := discoverSubnets(cfg.ScanIntervalSeconds)

	// MikroTik: the router's tables and subnets (routeros.go). Its subnets are
	// scanned (routed) like the server's extra subnets, so tunnels and checks
	// may target them; a failed collection leaves the scan as it was.
	var ros *RouterOSResult
	if routerOSEnabled() {
		if r, err := collectRouterOS(context.Background()); err == nil && r != nil {
			ros = r
			subnets = appendNewSubnets(subnets, r.Subnets)
		}
	}

	var scannedSubnets []string
	var scannedNets []*net.IPNet
	var devices []DiscoveredDevice

	for _, sn := range subnets {
		if isExcluded(sn.String()) {
			continue
		}
		scannedSubnets = append(scannedSubnets, sn.String())
		scannedNets = append(scannedNets, sn)
	}
	// Record the scan scope before scanning: tunnel / check targets are only
	// allowed inside these subnets (see allowedLanTarget).
	setLastScannedSubnets(scannedNets)

	// One call for every subnet: the ARP re-validation wait happens once per
	// cycle, not once per subnet (see scanSubnets).
	found, skipped := scanSubnets(scannedNets, localNets, time.Duration(cfg.ScanIntervalSeconds)*time.Second)
	devices = append(devices, found...)
	if ros != nil {
		// Hosts the router saw (ARP of every interface / VLAN), inside the
		// scanned (non-excluded) subnets only.
		devices = mergeRouterOSDevices(devices, routerOSDevicesIn(ros.Devices, scannedNets))
	}

	scanDurationMs := time.Since(scanStart).Milliseconds()

	// Inject the probe itself into the discovered devices list.
	myMac := probeMac()
	if myMac != "" {
		myIP := probeLocalIP()
		if myIP != "" {
			found := false
			for i, d := range devices {
				if d.IP == myIP {
					devices[i].MAC = myMac
					devices[i].IsOnline = true
					found = true
					break
				}
			}
			if !found {
				devices = append(devices, DiscoveredDevice{
					IP:       myIP,
					MAC:      myMac,
					Hostname: hostname(),
					IsOnline: true,
				})
			}
		}
	}

	log.Printf("Scan complete: %d devices in %d subnets (%dms)",
		len(devices), len(scannedSubnets), scanDurationMs)
	for _, sk := range skipped {
		log.Printf("  skipped subnet %s (%s)", sk.CIDR, sk.Reason)
	}

	var discoveredFlows []FlowEntry
	if flowAnalysisEnabled() {
		discoveredFlows = collectFlows()
	}

	allIPs := probeLocalIPs()

	body := PushBody{
		Hostname:          hostname(),
		ProbeVersion:      ProbeVersion,
		OSInfo:            osInfo(),
		ProbeMac:          myMac,
		ProbeIPs:          allIPs,
		DiscoveredDevices: devices,
		DiscoveredFlows:   discoveredFlows,
		ScannedSubnets:    scannedSubnets,
		ScanDurationMs:    scanDurationMs,
		Capabilities:      probeCapabilities(),
		ServerScheme:      serverScheme(),
	}
	attachSkippedSubnets(&body, skipped)
	return body
}

// attachSkippedSubnets sets body.SkippedSubnets (at most
// maxReportedSkippedSubnets) when the server advertised that it accepts
// them; otherwise the field stays nil and is left out of the JSON.
func attachSkippedSubnets(body *PushBody, skipped []SkippedSubnet) {
	if len(skipped) == 0 || !skippedSubnetsAccepted() {
		return
	}
	if len(skipped) > maxReportedSkippedSubnets {
		skipped = skipped[:maxReportedSkippedSubnets]
	}
	body.SkippedSubnets = append([]SkippedSubnet(nil), skipped...)
}

// applyPushResponse updates local config from the server's push/config response.
// The device check assignment is handed to the check manager (a no-op while
// its rev is unchanged; nil stops every check).
func applyPushResponse(pushResp PushResponse) {
	if pushResp.Config.ScanIntervalSeconds > 0 {
		cfg.ScanIntervalSeconds = pushResp.Config.ScanIntervalSeconds
	}
	scanCfgMu.Lock()
	cachedExcluded = pushResp.Config.ExcludedSubnets
	serverExtraSubnets = pushResp.Config.ExtraSubnets
	cachedPortScanEnabled = pushResp.Config.PortScanEnabled
	if pushResp.Config.PortScanPorts != nil {
		cachedPortScanPorts = pushResp.Config.PortScanPorts
	}
	cachedFlowAnalysisEnabled = pushResp.Config.FlowAnalysisEnabled
	cachedAcceptsSkippedSubnets = pushResp.Config.AcceptsSkippedSubnets
	scanCfgMu.Unlock()
	if checkMgr != nil {
		checkMgr.Apply(pushResp.Config.DeviceChecks)
	}
	saveConfig()
}

// rescanRequested is set when an HTTP push response carries the "rescan"
// command. The HTTP polling loop (main.go) consumes it with Swap(false) and
// then waits only rescanFloor instead of the full scan interval. WS mode does
// not use it (the control channel triggers its scan worker directly).
var rescanRequested atomic.Bool

// doPush performs one full scan+push cycle via HTTP. Returns the next interval in seconds.
func doPush() int {
	return pushScanResult(doScan())
}

// pushScanResult sends one scan report to POST /api/probe/push and applies
// the server's answer (identity token, config, update check, then the
// one-shot command). Returns the next interval in seconds.
func pushScanResult(body PushBody) int {
	payload, err := json.Marshal(body)
	if err != nil {
		log.Printf("ERROR: marshal push body: %v", err)
		return cfg.ScanIntervalSeconds
	}

	url := fmt.Sprintf("%s/api/probe/push", cfg.ServerURL)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		log.Printf("ERROR: create push request: %v", err)
		return cfg.ScanIntervalSeconds
	}
	req.Header.Set("Content-Type", "application/json")
	setProbeAuthHeaders(req.Header, true)
	// Identity v2: announce the shared device ID while a switch is pending
	// (the server re-keys this probe and answers X-Obli-Device-Id-Ack).
	applyIdentityHeaders(req.Header)
	identityTarget := req.Header.Get(IdentityHeaderTarget)
	if identityTarget != "" {
		noteIdentityPushAttempt()
	}

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("WARN: push failed: %v", err)
		return cfg.ScanIntervalSeconds
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		log.Printf("WARN: 401 unauthorized (%s) — check API key / probe token. Backing off.", pushErrorCode(resp))
		backoff := backoffLevels[min(backoffIdx, len(backoffLevels)-1)]
		backoffIdx++
		cfg.BackoffUntil = time.Now().Add(backoff).UnixMilli()
		saveConfig()
		return int(backoff.Seconds())
	}
	backoffIdx = 0
	cfg.BackoffUntil = 0

	// Only a 200 (approved) or 202 (pending) response carries a config. Any
	// other answer (403 refused, 409 conflict, 4xx/5xx errors) must not wipe
	// the cached exclusions / port list with an empty config.
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		log.Printf("WARN: push rejected by server (HTTP %d, %s) — keeping current config", resp.StatusCode, pushErrorCode(resp))
		return cfg.ScanIntervalSeconds
	}

	// Identity v2: the server answered the push carrying the shared ID — it
	// either acknowledged it (switch now: config saved, WS redialled) or
	// does not know v2 / refused the claim (stay on the current ID).
	if identityTarget != "" {
		noteIdentityPushAnswered(identityTarget)
	}
	handleIdentityAck(resp)

	var pushResp PushResponse
	if err := json.NewDecoder(resp.Body).Decode(&pushResp); err != nil {
		log.Printf("WARN: decode push response: %v", err)
		return cfg.ScanIntervalSeconds
	}

	// Identity token issued by the server (trust on first use).
	if pushResp.ProbeToken != "" {
		storeProbeToken(pushResp.ProbeToken)
	}

	// The config carried by the response is applied even when a command rides
	// along (a pending command must not cost the probe its config update).
	applyPushResponse(pushResp)

	// Check for update. Skipped when the response carries "uninstall" (an
	// update racing the uninstall could reinstall the probe) or "update"
	// (handleCommand runs applyUpdate itself).
	if shouldAutoUpdate(pushResp.Command, pushResp.LatestVersion, ProbeVersion) {
		log.Printf("Update available: %s → %s", ProbeVersion, pushResp.LatestVersion)
		go applyUpdate(pushResp.LatestVersion)
	}

	if resp.StatusCode == http.StatusAccepted {
		log.Printf("Status: pending approval (202)")
	}

	// Process command (one-shot), after the config so "rescan" scans with it.
	if pushResp.Command != "" {
		log.Printf("Received command: %s", pushResp.Command)
		handleCommand(pushResp.Command, pushResp.Config.ScanIntervalSeconds)
	}

	return cfg.ScanIntervalSeconds
}

// shouldAutoUpdate tells whether a push response triggers the automatic
// self-update: a strictly newer latestVersion, and no "uninstall" / "update"
// command in the same response.
func shouldAutoUpdate(command, latestVersion, current string) bool {
	if command == "uninstall" || command == "update" {
		return false
	}
	return latestVersion != "" && isStrictlyNewer(latestVersion, current)
}

// pushErrorCode extracts the short error code of a rejected push
// ({"error":"probe_token_invalid"}) for the log. Reads at most 4 KiB.
func pushErrorCode(resp *http.Response) string {
	var body struct {
		Error string `json:"error"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body) != nil || body.Error == "" {
		return "no error code"
	}
	// Printable ASCII only: the value comes from the network and goes to the log.
	clean := make([]byte, 0, len(body.Error))
	for i := 0; i < len(body.Error); i++ {
		if c := body.Error[i]; c >= 0x20 && c < 0x7f {
			clean = append(clean, c)
		}
	}
	return truncate(string(clean), 64)
}

// ─── Cached scan configuration ───────────────────────────────────────────────
//
// The scan configuration of the last server response is written by the WS
// read loop / HTTP push (applyPushResponse) and read by the scan worker and by
// tunnel goroutines (allowedLanTarget → isExcluded), so every access goes
// through scanCfgMu. Slices are only ever replaced, never modified in place:
// a slice read under the lock can be iterated after it is released.
var (
	scanCfgMu                 sync.RWMutex
	cachedExcluded            []string // subnet exclusions (guarded by scanCfgMu)
	serverExtraSubnets        []string // extra subnets to scan (guarded by scanCfgMu)
	cachedPortScanEnabled     bool     // guarded by scanCfgMu
	cachedPortScanPorts       []int    // guarded by scanCfgMu
	cachedFlowAnalysisEnabled bool     // guarded by scanCfgMu
	// cachedAcceptsSkippedSubnets: the last config advertised
	// acceptsSkippedSubnets (guarded by scanCfgMu)
	cachedAcceptsSkippedSubnets bool
)

// cachedExtra is the extra-subnet list read by discoverSubnets
// (subnet_discover.go). doScan refreshes it from serverExtraSubnets while
// holding scanMu, so only the goroutine running doScan ever touches it.
var cachedExtra []string

// scanMu serialises doScan: the scan worker of a WS session that just ended
// can still be scanning when the next session starts its first scan.
var scanMu sync.Mutex

// excludedSubnets returns the current subnet exclusion list (do not modify).
func excludedSubnets() []string {
	scanCfgMu.RLock()
	defer scanCfgMu.RUnlock()
	return cachedExcluded
}

// portScanSettings returns whether full port scanning is enabled and on which
// ports (do not modify the slice).
func portScanSettings() (bool, []int) {
	scanCfgMu.RLock()
	defer scanCfgMu.RUnlock()
	return cachedPortScanEnabled, cachedPortScanPorts
}

// skippedSubnetsAccepted reports whether the last server config advertised
// acceptsSkippedSubnets.
func skippedSubnetsAccepted() bool {
	scanCfgMu.RLock()
	defer scanCfgMu.RUnlock()
	return cachedAcceptsSkippedSubnets
}

// flowAnalysisEnabled reports whether TCP flow collection is enabled.
func flowAnalysisEnabled() bool {
	scanCfgMu.RLock()
	defer scanCfgMu.RUnlock()
	return cachedFlowAnalysisEnabled
}

func isExcluded(subnet string) bool {
	excluded := excludedSubnets()
	_, snNet, err := net.ParseCIDR(subnet)
	if err != nil {
		// Fallback: exact string match
		for _, ex := range excluded {
			if ex == subnet {
				return true
			}
		}
		return false
	}
	snKey := snNet.String() // canonical form e.g. "192.168.1.0/24"

	for _, ex := range excluded {
		// Try parsing the exclusion as CIDR
		_, exNet, err2 := net.ParseCIDR(ex)
		if err2 != nil {
			// Maybe bare network like "192.168.1.0" — try with /24
			_, exNet, err2 = net.ParseCIDR(ex + "/24")
			if err2 != nil {
				if ex == subnet {
					return true
				}
				continue
			}
		}
		if exNet.String() == snKey {
			return true
		}
		// Also check if the scanned subnet is contained within the exclusion
		if exNet.Contains(snNet.IP) {
			ones1, _ := exNet.Mask.Size()
			ones2, _ := snNet.Mask.Size()
			if ones1 <= ones2 {
				return true
			}
		}
	}
	return false
}

func handleCommand(command string, scanInterval int) {
	switch command {
	case "uninstall":
		log.Println("Executing uninstall command...")
		performUninstall(cfg.ServerURL)
		os.Exit(0)
	case "update":
		log.Println("Executing update command...")
		applyUpdate("")
	case "rescan":
		// HTTP mode: the polling loop (main.go) sees the flag and starts the
		// next scan after rescanFloor instead of the full interval. WS mode
		// never gets here for "rescan" (dispatchWsCommand triggers its scan
		// worker directly).
		log.Println("Rescan command received — next scan starts shortly")
		rescanRequested.Store(true)
	default:
		log.Printf("Unknown command: %s", command)
	}
}

// ─── Version helpers ──────────────────────────────────────────────────────────

func isStrictlyNewer(remote, current string) bool {
	var rMaj, rMin, rPatch int
	var cMaj, cMin, cPatch int
	fmt.Sscanf(remote, "%d.%d.%d", &rMaj, &rMin, &rPatch)
	fmt.Sscanf(current, "%d.%d.%d", &cMaj, &cMin, &cPatch)
	if rMaj != cMaj {
		return rMaj > cMaj
	}
	if rMin != cMin {
		return rMin > cMin
	}
	return rPatch > cPatch
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
