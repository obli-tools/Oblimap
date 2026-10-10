package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ─── WebSocket connection state ─────────────────────────────────────────────

var (
	wsConn     *websocket.Conn
	wsMu       sync.Mutex
	wsConnFlag bool
)

// wsWriteTimeout bounds every write on the control WebSocket so a stalled
// connection cannot block the writers (they all share wsMu) forever. Large
// messages (scan_result of a big site on a slow uplink) get one extra second
// per wsWriteMinRate bytes on top of it (see wsWriteDeadline).
const (
	wsWriteTimeout = 30 * time.Second
	wsWriteMinRate = 16 << 10 // bytes per second (~128 kbit/s)
)

// wsWriteDeadline returns the write deadline for a message of n bytes.
func wsWriteDeadline(n int) time.Time {
	return time.Now().Add(wsWriteTimeout + time.Duration(n/wsWriteMinRate)*time.Second)
}

// wsWriteJSONLocked marshals v and writes it as one text message with a
// size-scaled write deadline. The caller holds wsMu.
func wsWriteJSONLocked(conn *websocket.Conn, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_ = conn.SetWriteDeadline(wsWriteDeadline(len(data)))
	return conn.WriteMessage(websocket.TextMessage, data)
}

// errWsNotConnected is returned by wsSendCurrent when no control WS is open.
var errWsNotConnected = errors.New("websocket not connected")

// wsMessage is the JSON envelope for all WS messages.
type wsMessage struct {
	Type string `json:"type"`
	// Additional fields depend on type — decoded dynamically
}

// ─── Probe WebSocket availability check ─────────────────────────────────────

// wsAvailable tests if the server supports the raw WebSocket endpoint /api/probe/ws.
func wsAvailable() bool {
	wsURL := buildWsURL()
	if wsURL == "" {
		return false
	}

	log.Printf("WS probe: testing connection to %s", wsURL)

	// Throw-away connection: do NOT advertise X-Probe-Features here, otherwise
	// the server could issue the identity token on a socket we close unread.
	headers := buildWsHeaders(false)
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, resp, err := dialer.Dial(wsURL, headers)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		log.Printf("WS probe: dial failed (HTTP %d): %v — using HTTP fallback", status, err)
		return false
	}
	conn.Close()
	log.Printf("WS probe: server supports raw WebSocket on /api/probe/ws")
	return true
}

// buildWsURL converts the server URL to the raw WS endpoint.
func buildWsURL() string {
	if cfg.ServerURL == "" {
		return ""
	}
	u, err := url.Parse(cfg.ServerURL)
	if err != nil {
		return ""
	}
	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}
	return fmt.Sprintf("%s://%s/api/probe/ws", scheme, u.Host)
}

// buildWsHeaders returns HTTP headers for a WS upgrade handshake (control and
// tunnel sockets): API key, UUID, identity token when issued, and the
// X-Probe-Features advertisement when advertiseFeatures is set.
func buildWsHeaders(advertiseFeatures bool) http.Header {
	h := http.Header{}
	setProbeAuthHeaders(h, advertiseFeatures)
	// Identity v2: announce the pending shared device ID (the server only
	// uses it to find the probe; the HTTP push does the re-keying).
	applyIdentityHeaders(h)
	if u, err := url.Parse(cfg.ServerURL); err == nil {
		h.Set("Host", u.Host)
	}
	return h
}

// ─── WebSocket main loop ────────────────────────────────────────────────────

func wsMainLoop() {
	backoff := time.Second
	maxBackoff := 60 * time.Second

	for {
		err := wsRun()
		if err != nil {
			log.Printf("WS connection lost: %v", err)
		}

		jitter := time.Duration(rand.Int63n(int64(backoff / 4)))
		sleepTime := backoff + jitter
		log.Printf("WS reconnecting in %v...", sleepTime.Round(time.Second))
		time.Sleep(sleepTime)

		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// wsSession holds the per-connection channels shared by the read loop
// (handleWsMsg) and the scan ticker / scan worker goroutines.
type wsSession struct {
	scanTrigger chan struct{}      // buffered(1): request a scan now
	intervalCh  chan time.Duration // buffered(1): new scan interval
}

// triggerScan requests a scan without blocking (coalesced with a pending one).
func (s *wsSession) triggerScan() {
	select {
	case s.scanTrigger <- struct{}{}:
	default:
	}
}

// setScanInterval hands a new interval to the ticker goroutine, replacing any
// value it has not consumed yet. Only the read loop calls it.
func (s *wsSession) setScanInterval(d time.Duration) {
	select {
	case <-s.intervalCh:
	default:
	}
	select {
	case s.intervalCh <- d:
	default:
	}
}

// wsScanInterval converts the configured scan interval into the ticker
// period (never below 30 s).
func wsScanInterval(seconds int) time.Duration {
	interval := time.Duration(seconds) * time.Second
	if interval < 30*time.Second {
		interval = 30 * time.Second
	}
	return interval
}

// wsRun establishes a raw WebSocket connection and runs until disconnection.
func wsRun() error {
	wsURL := buildWsURL()
	if wsURL == "" {
		return fmt.Errorf("no server URL configured")
	}

	headers := buildWsHeaders(true)
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}

	conn, resp, err := dialer.Dial(wsURL, headers)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		return fmt.Errorf("dial failed (HTTP %d): %w", status, err)
	}

	// stop is closed exactly once when the session ends (read error, failed
	// write, or return); every goroutine of this session selects on it, so none
	// of them can block forever on a channel nobody reads any more. errCh
	// keeps the first error.
	stop := make(chan struct{})
	var stopOnce sync.Once
	errCh := make(chan error, 1)
	fail := func(err error) {
		select {
		case errCh <- err:
		default:
		}
		stopOnce.Do(func() {
			close(stop)
			conn.Close() // unblocks the read loop (Close is safe concurrently)
		})
	}

	defer func() {
		stopOnce.Do(func() { close(stop) })
		wsMu.Lock()
		if wsConn == conn {
			wsConn = nil
			wsConnFlag = false
		}
		wsMu.Unlock()
		conn.Close()
	}()

	wsMu.Lock()
	wsConn = conn
	wsConnFlag = true
	wsMu.Unlock()

	log.Printf("WS connected to %s", cfg.ServerURL)

	// Announce the optional features this probe supports. A new server
	// replies with a config_update (device check assignment included); an
	// old one logs the unknown message type and ignores it.
	hello := map[string]interface{}{
		"type":         "hello",
		"probeVersion": ProbeVersion,
		"capabilities": probeCapabilities(),
	}
	if scheme := serverScheme(); scheme != "" {
		hello["serverScheme"] = scheme
	}
	if err := wsSendJSON(conn, hello); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	s := &wsSession{
		scanTrigger: make(chan struct{}, 1),
		intervalCh:  make(chan time.Duration, 1),
	}
	initialInterval := wsScanInterval(cfg.ScanIntervalSeconds)

	// Scan ticker — triggers scans at the configured interval; the period is
	// reset whenever a config_update changes the scan interval.
	go func() {
		// Initial scan immediately
		s.triggerScan()

		ticker := time.NewTicker(initialInterval)
		defer ticker.Stop()

		for {
			select {
			case <-stop:
				return
			case d := <-s.intervalCh:
				ticker.Reset(d)
				log.Printf("WS scan interval set to %v", d)
			case <-ticker.C:
				s.triggerScan()
			}
		}
	}()

	// Scan worker — performs scans and sends results
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-s.scanTrigger:
			}
			body := doScan()
			select {
			case <-stop:
				return
			default:
			}
			// Identity v2: a switch to the shared device ID started while on
			// the WS (regen script, clone detected by another Obli* agent) is
			// acknowledged by the HTTP push only — send this scan that way.
			// The WS takes it when the server did not answer the push.
			if identityHTTPPushDue() {
				target := pendingIdentityTarget()
				pushScanResult(body)
				if identityHTTPPushAnswered(target) {
					continue
				}
			}
			if err := wsSendJSON(conn, map[string]interface{}{
				"type":    "scan_result",
				"payload": body,
			}); err != nil {
				log.Printf("WS send scan_result failed: %v", err)
				fail(err)
				return
			}
		}
	}()

	// Heartbeat — every 25s (matches server's 15s ping interval window)
	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := wsSendJSON(conn, map[string]string{"type": "heartbeat"}); err != nil {
					fail(err)
					return
				}
			case <-stop:
				return
			}
		}
	}()

	// Respond to server pings (RFC 6455 ping/pong is handled by gorilla/websocket
	// automatically via SetPongHandler — but we also set a read deadline)
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(45 * time.Second))
		return nil
	})
	conn.SetReadDeadline(time.Now().Add(45 * time.Second))

	// Main read loop
	for {
		_, rawMsg, err := conn.ReadMessage()
		if err != nil {
			fail(err)
			return <-errCh // the first error of the session
		}
		conn.SetReadDeadline(time.Now().Add(45 * time.Second))

		var msg map[string]json.RawMessage
		if json.Unmarshal(rawMsg, &msg) != nil {
			continue
		}

		var msgType string
		if json.Unmarshal(msg["type"], &msgType) != nil {
			continue
		}

		handleWsMsg(msgType, rawMsg, s)
	}
}

// ─── Message helpers ────────────────────────────────────────────────────────

func wsSendJSON(conn *websocket.Conn, v interface{}) error {
	wsMu.Lock()
	defer wsMu.Unlock()
	return wsWriteJSONLocked(conn, v)
}

// wsSendCurrent writes v as JSON on the current control WebSocket, if any.
// Safe to call from any goroutine (tunnels, reporters…).
func wsSendCurrent(v any) error {
	wsMu.Lock()
	defer wsMu.Unlock()
	if wsConn == nil {
		return errWsNotConnected
	}
	return wsWriteJSONLocked(wsConn, v)
}

// reconnectControlWS closes the current control WebSocket, if any: wsMainLoop
// redials with the current headers (identity v2: the new device ID after the
// server's ack).
func reconnectControlWS() {
	wsMu.Lock()
	conn := wsConn
	wsMu.Unlock()
	if conn != nil {
		log.Printf("WS: reconnecting under device ID %s", currentDeviceUUID())
		conn.Close() // the read loop fails and wsRun returns (Close is safe concurrently)
	}
}

// wsConnected reports whether a control WebSocket is currently open.
func wsConnected() bool {
	wsMu.Lock()
	defer wsMu.Unlock()
	return wsConn != nil
}

// dispatchWsCommand runs a one-shot command received over the control WS,
// either as a "command" message or inside a config_update (same envelope as
// the HTTP PushResponse). The read loop must keep running: "rescan" only
// triggers the scan worker and "update" runs in the background.
func dispatchWsCommand(command string, s *wsSession) {
	log.Printf("WS received command: %s", command)
	switch command {
	case "rescan":
		s.triggerScan()
	case "update":
		go handleCommand(command, cfg.ScanIntervalSeconds)
	default:
		handleCommand(command, cfg.ScanIntervalSeconds)
	}
}

// acceptProbeToken stores an identity token delivered over the control WS and
// acknowledges it (the acknowledgement never contains the token).
func acceptProbeToken(token string) {
	persisted := storeProbeToken(token)
	if err := wsSendCurrent(map[string]interface{}{"type": "probe_token_ack", "persisted": persisted}); err != nil {
		log.Printf("WARN: could not acknowledge probe identity token: %v", err)
	}
}

func handleWsMsg(msgType string, raw []byte, s *wsSession) {
	switch msgType {
	case "command":
		var msg struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(raw, &msg) == nil && msg.Command != "" {
			dispatchWsCommand(msg.Command, s)
		}

	case "config_update":
		var msg struct {
			Status        string               `json:"status"`
			Config        *ProbeResponseConfig `json:"config"`
			LatestVersion string               `json:"latestVersion"`
			Command       string               `json:"command"`
			ProbeToken    string               `json:"probeToken"`
		}
		if json.Unmarshal(raw, &msg) == nil {
			if msg.ProbeToken != "" {
				acceptProbeToken(msg.ProbeToken)
			}
			// Same rule as the HTTP push: an answer without a usable config
			// (rejected key, refused probe) must not wipe the cached
			// exclusions / port list with an empty one.
			if msg.Config != nil && msg.Status != "unauthorized" {
				prevInterval := cfg.ScanIntervalSeconds
				applyPushResponse(PushResponse{Config: *msg.Config, LatestVersion: msg.LatestVersion})
				log.Printf("WS config updated (interval=%ds, flow=%v)",
					cfg.ScanIntervalSeconds, flowAnalysisEnabled())
				if cfg.ScanIntervalSeconds != prevInterval {
					s.setScanInterval(wsScanInterval(cfg.ScanIntervalSeconds))
				}
			} else {
				log.Printf("WS config_update without a usable config (status %q) — keeping current config", truncate(msg.Status, 32))
			}
			// A command queued while the WS was down is delivered here
			// (pending_command) — the server has already cleared it.
			if msg.Command != "" {
				dispatchWsCommand(msg.Command, s)
			}
			// The server announces latestVersion only when the probe's update
			// policy is 'auto' (updatePolicyCapability); same rule as the HTTP
			// push for a command riding along.
			if shouldAutoUpdate(msg.Command, msg.LatestVersion, ProbeVersion) {
				log.Printf("Update available: %s → %s", ProbeVersion, msg.LatestVersion)
				go applyUpdate(msg.LatestVersion)
			}
		}

	case "probe_token":
		var msg struct {
			Token string `json:"token"`
		}
		if json.Unmarshal(raw, &msg) == nil && msg.Token != "" {
			acceptProbeToken(msg.Token)
		}

	case "tunnel_open":
		var msg struct {
			TunnelID   string `json:"tunnelId"`
			TargetIP   string `json:"targetIp"`
			TargetPort int    `json:"targetPort"`
		}
		if json.Unmarshal(raw, &msg) == nil && msg.TunnelID != "" {
			go handleTunnelOpen(msg.TunnelID, msg.TargetIP, msg.TargetPort)
		}

	case "tunnel_close":
		var msg struct {
			TunnelID string `json:"tunnelId"`
		}
		if json.Unmarshal(raw, &msg) == nil && msg.TunnelID != "" {
			handleTunnelClose(msg.TunnelID)
		}

	case "check_test":
		// One-off device check run requested from the rule editor. It runs in
		// its own goroutine (the read loop must keep running) and answers
		// check_test_result with the same testId.
		var msg struct {
			TestID string       `json:"testId"`
			Rule   *CheckRule   `json:"rule"`
			Target *CheckTarget `json:"target"`
		}
		if json.Unmarshal(raw, &msg) != nil || msg.Rule == nil || msg.Target == nil || !checkTestIDRe.MatchString(msg.TestID) {
			log.Printf("WS check_test: malformed request ignored")
			return
		}
		if checkMgr == nil {
			return
		}
		go func(testID string, rule CheckRule, target CheckTarget) {
			res := checkMgr.Test(rule, target)
			if err := wsSendCurrent(map[string]interface{}{
				"type":   "check_test_result",
				"testId": testID,
				"result": res,
			}); err != nil {
				log.Printf("WS check_test_result not sent: %v", err)
			}
		}(msg.TestID, *msg.Rule, *msg.Target)

	case "check_run_now":
		var msg struct {
			RuleID int `json:"ruleId"`
			ItemID int `json:"itemId"`
		}
		if json.Unmarshal(raw, &msg) == nil && checkMgr != nil {
			if !checkMgr.RunNow(msg.RuleID, msg.ItemID) {
				log.Printf("WS check_run_now: no device check %d:%d on this probe — ignored", msg.RuleID, msg.ItemID)
			}
		}

	case "heartbeat_ack":
		// no-op

	default:
		log.Printf("WS unknown message type: %s", truncate(msgType, 64))
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// Keep strings import used
var _ = strings.HasPrefix
