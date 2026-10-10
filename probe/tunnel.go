package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// ─── Active tunnel tracking ─────────────────────────────────────────────────

// activeTunnel is registered in tunnels as soon as tunnel_open is accepted
// (reserving the id while the TCP and WS dials run) and stays there until the
// relay ends or the server closes it.
type activeTunnel struct {
	tunnelID   string
	targetIP   string
	targetPort int
	done       chan struct{} // closed by cancel
	stopOnce   sync.Once

	// mu guards tcpConn / wsConn while the tunnel is opening; they are not
	// changed once the relay has started.
	mu      sync.Mutex
	tcpConn net.Conn
	wsConn  *websocket.Conn

	// lastActivity is the unix-nano time of the last byte relayed in either
	// direction (idle watchdog).
	lastActivity atomic.Int64
}

// cancel ends the tunnel, whether it is still opening or relaying: it closes
// done and every connection attached so far. Safe to call more than once.
func (t *activeTunnel) cancel() {
	t.stopOnce.Do(func() { close(t.done) })
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tcpConn != nil {
		t.tcpConn.Close()
	}
	if t.wsConn != nil {
		t.wsConn.Close()
	}
}

// cancelled reports whether cancel has been called.
func (t *activeTunnel) cancelled() bool {
	select {
	case <-t.done:
		return true
	default:
		return false
	}
}

// attach records a connection of an opening tunnel (exactly one of tcp / ws
// is non-nil). When the tunnel was cancelled meanwhile it closes the
// connection instead and returns false.
func (t *activeTunnel) attach(tcp net.Conn, ws *websocket.Conn) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.cancelled() {
		if tcp != nil {
			tcp.Close()
		}
		if ws != nil {
			ws.Close()
		}
		return false
	}
	if tcp != nil {
		t.tcpConn = tcp
	}
	if ws != nil {
		t.wsConn = ws
	}
	return true
}

var (
	tunnels   = make(map[string]*activeTunnel)
	tunnelsMu sync.Mutex
)

// unregisterTunnel removes t from tunnels if it is still the registered entry
// for its id.
func unregisterTunnel(t *activeTunnel) {
	tunnelsMu.Lock()
	if tunnels[t.tunnelID] == t {
		delete(tunnels, t.tunnelID)
	}
	tunnelsMu.Unlock()
}

const (
	// tunnelIdleTimeout closes a relay that moved no byte in either direction.
	tunnelIdleTimeout = 10 * time.Minute
	// maxActiveTunnels bounds concurrent relays on this probe (the server
	// caps tunnels at 20 per tenant; this only stops abuse).
	maxActiveTunnels = 32
	// Dial budgets: both must fit in the server's 15 s wait for tunnel_ready.
	tunnelTCPDialTimeout = 7 * time.Second
	tunnelWSDialTimeout  = 7 * time.Second
)

// tunnelSlots is a counting semaphore of maxActiveTunnels (opening + active).
var tunnelSlots = make(chan struct{}, maxActiveTunnels)

// tunnelIDRe: server-generated tunnel ids are UUIDs; anything else is refused
// before it is put into a URL.
var tunnelIDRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// handleTunnelOpen is called when the server requests a new tunnel.
// It validates the target (private LAN host inside the scanned subnets, see
// allowedLanTarget), dials it, opens a dedicated WebSocket back to the server
// for binary relay, reports tunnel_ready and starts bidirectional forwarding.
func handleTunnelOpen(tunnelID, targetIP string, targetPort int) {
	if !tunnelIDRe.MatchString(tunnelID) {
		log.Printf("Tunnel: refusing open request with malformed tunnel id")
		return
	}
	if targetPort < 1 || targetPort > 65535 {
		log.Printf("Tunnel %s: refused, invalid target port %d", tunnelID, targetPort)
		wsSendTunnelError(tunnelID, errTargetNotAllowed.Error())
		return
	}
	if err := allowedLanTarget(targetIP); err != nil {
		log.Printf("Tunnel %s: refused: %v", tunnelID, err)
		wsSendTunnelError(tunnelID, errTargetNotAllowed.Error())
		return
	}

	select {
	case tunnelSlots <- struct{}{}:
	default:
		log.Printf("Tunnel %s: refused, %d tunnels already active", tunnelID, maxActiveTunnels)
		wsSendTunnelError(tunnelID, "too_many_tunnels")
		return
	}
	releaseSlot := func() { <-tunnelSlots }

	// Reserve the id in the same critical section as the duplicate check, so
	// a second tunnel_open with the same id is refused while this one dials.
	tunnel := &activeTunnel{
		tunnelID:   tunnelID,
		targetIP:   targetIP,
		targetPort: targetPort,
		done:       make(chan struct{}),
	}
	tunnelsMu.Lock()
	_, exists := tunnels[tunnelID]
	if !exists {
		tunnels[tunnelID] = tunnel
	}
	tunnelsMu.Unlock()
	if exists {
		releaseSlot()
		log.Printf("Tunnel %s: refused, tunnel id already in use", tunnelID)
		wsSendTunnelError(tunnelID, "tunnel_exists")
		return
	}

	// abort undoes the reservation (and closes whatever was dialed so far).
	abort := func() {
		unregisterTunnel(tunnel)
		tunnel.cancel()
		releaseSlot()
	}

	addr := net.JoinHostPort(targetIP, strconv.Itoa(targetPort))
	log.Printf("Tunnel %s: opening TCP to %s", tunnelID, addr)

	// 1. Dial TCP to target (also the reachability check of the HTTP relay
	//    mode, which closes this connection and dials per request).
	tcpConn, err := net.DialTimeout("tcp4", addr, tunnelTCPDialTimeout)
	if err != nil {
		abort()
		log.Printf("Tunnel %s: TCP dial failed: %v", tunnelID, err)
		wsSendTunnelError(tunnelID, tunnelDialErrorText(err))
		return
	}
	if !tunnel.attach(tcpConn, nil) {
		abort()
		log.Printf("Tunnel %s: closed by the server while opening", tunnelID)
		return
	}

	// 2. Open dedicated WebSocket to server for binary relay. This happens
	//    before tunnel_ready so the data socket is registered while the
	//    server-side tunnel is still "opening".
	tunnelWS, err := dialTunnelWS(tunnelID)
	if err != nil {
		abort()
		log.Printf("Tunnel %s: WS dial failed: %v", tunnelID, err)
		wsSendTunnelError(tunnelID, err.Error())
		return
	}
	if !tunnel.attach(nil, tunnelWS) {
		abort()
		log.Printf("Tunnel %s: closed by the server while opening", tunnelID)
		return
	}
	tunnel.lastActivity.Store(time.Now().UnixNano())

	// 2b. Announce the HTTP relay on the data socket. A server that knows it
	//     answers tunnel_mode; an older one ignores the frame and sends raw
	//     bytes (see tunnelServe).
	if err := tunnelWS.WriteJSON(map[string]any{"type": "tunnel_hello", "features": []string{tunnelHTTPFeature}}); err != nil {
		abort()
		log.Printf("Tunnel %s: could not announce the HTTP relay (%v) — closing", tunnelID, err)
		wsSendTunnelError(tunnelID, err.Error())
		return
	}

	// 3. Notify server that the tunnel is ready
	if tunnel.cancelled() {
		abort()
		log.Printf("Tunnel %s: closed by the server while opening", tunnelID)
		return
	}
	if err := wsSendTunnelReady(tunnelID); err != nil {
		log.Printf("Tunnel %s: could not send tunnel_ready (%v) — closing", tunnelID, err)
		abort()
		return
	}

	log.Printf("Tunnel %s: ready (%s)", tunnelID, addr)

	// 4. Serve the tunnel in the mode the server picks (releases the slot when it ends)
	go func() {
		defer releaseSlot()
		tunnelServe(tunnel)
	}()
}

// tunnelDialErrorText is the short reason reported to the server (shown to
// the user) when the target cannot be reached.
func tunnelDialErrorText(err error) string {
	switch classifyRelayError(err) {
	case "connection_refused":
		return "connection refused by the device (nothing listens on this port)"
	case "timeout":
		return "the device did not answer (timeout)"
	case "unreachable":
		return "the device is unreachable from the probe"
	}
	return err.Error()
}

// tunnelServe waits for the server to pick the tunnel's mode: tunnel_mode
// {mode:"http"} selects the multiplexed HTTP relay (the pre-dialed TCP
// connection is closed), while a first binary frame — what a server without
// the HTTP relay sends — selects the legacy raw TCP relay, starting with
// that frame. Other frames are ignored.
func tunnelServe(t *activeTunnel) {
	for {
		_ = t.wsConn.SetReadDeadline(time.Now().Add(tunnelIdleTimeout))
		kind, data, err := t.wsConn.ReadMessage()
		if err != nil {
			if !t.cancelled() {
				log.Printf("Tunnel %s: closed before use (%v)", t.tunnelID, err)
			}
			unregisterTunnel(t)
			t.cancel()
			return
		}
		_ = t.wsConn.SetReadDeadline(time.Time{})
		if kind == websocket.BinaryMessage {
			log.Printf("Tunnel %s: raw TCP relay", t.tunnelID)
			tunnelRelay(t, data)
			return
		}
		var mode struct {
			Type      string   `json:"type"`
			Mode      string   `json:"mode"`
			Scheme    string   `json:"scheme"`
			HostNames []string `json:"hostNames"`
		}
		if json.Unmarshal(data, &mode) != nil || mode.Type != "tunnel_mode" || mode.Mode != "http" {
			continue
		}
		t.mu.Lock()
		if t.tcpConn != nil {
			t.tcpConn.Close()
			t.tcpConn = nil
		}
		t.mu.Unlock()
		sink := &wsFrameSink{conn: t.wsConn}
		relay := newHTTPRelay(t.targetIP, t.targetPort, mode.Scheme, mode.HostNames, sink)
		log.Printf("Tunnel %s: HTTP relay to %s (scheme %s)", t.tunnelID,
			net.JoinHostPort(t.targetIP, strconv.Itoa(t.targetPort)), relayBaseScheme(relay))
		serveHTTPRelay(t, relay)
		return
	}
}

func relayBaseScheme(r *httpRelay) string {
	base, auto := r.currentBase()
	if auto {
		return base.Scheme + " (auto)"
	}
	return base.Scheme
}

// handleTunnelClose closes a tunnel, including one that is still opening
// (its pending dials are then discarded instead of becoming active).
func handleTunnelClose(tunnelID string) {
	tunnelsMu.Lock()
	tunnel, ok := tunnels[tunnelID]
	if ok {
		delete(tunnels, tunnelID)
	}
	tunnelsMu.Unlock()

	if !ok {
		return
	}

	log.Printf("Tunnel %s: closing", tunnelID)
	tunnel.cancel()
}

// tunnelRelay forwards data between TCP and WebSocket connections until either
// side closes, the server sends tunnel_close, or no byte moved in either
// direction for tunnelIdleTimeout. first (the frame that selected this mode)
// is written to the target before anything else.
func tunnelRelay(t *activeTunnel, first []byte) {
	defer func() {
		unregisterTunnel(t)
		t.cancel()
		log.Printf("Tunnel %s: closed", t.tunnelID)
	}()

	errCh := make(chan error, 2)
	touch := func() { t.lastActivity.Store(time.Now().UnixNano()) }

	if len(first) > 0 {
		touch()
		if _, err := t.tcpConn.Write(first); err != nil {
			log.Printf("Tunnel %s: relay error: %v", t.tunnelID, err)
			return
		}
	}

	// TCP → WS
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := t.tcpConn.Read(buf)
			if n > 0 {
				touch()
				if wErr := t.wsConn.WriteMessage(websocket.BinaryMessage, buf[:n]); wErr != nil {
					errCh <- wErr
					return
				}
			}
			if err != nil {
				errCh <- err
				return
			}
		}
	}()

	// WS → TCP
	go func() {
		for {
			_, data, err := t.wsConn.ReadMessage()
			if err != nil {
				errCh <- err
				return
			}
			touch()
			if _, err := t.tcpConn.Write(data); err != nil {
				errCh <- err
				return
			}
		}
	}()

	idleCheck := time.NewTicker(30 * time.Second)
	defer idleCheck.Stop()

	// Wait for either side to close, an explicit close command, or idleness
	for {
		select {
		case err := <-errCh:
			if err != nil && !errors.Is(err, io.EOF) {
				log.Printf("Tunnel %s: relay error: %v", t.tunnelID, err)
			}
			return
		case <-t.done:
			return
		case <-idleCheck.C:
			idle := time.Since(time.Unix(0, t.lastActivity.Load()))
			if idle >= tunnelIdleTimeout {
				log.Printf("Tunnel %s: idle for %v — closing", t.tunnelID, idle.Round(time.Second))
				return
			}
		}
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// dialTunnelWS opens a dedicated WebSocket to the server's /api/probe/ws/tunnel
// endpoint, authenticated exactly like the control WebSocket (API key, UUID,
// identity token).
func dialTunnelWS(tunnelID string) (*websocket.Conn, error) {
	u, err := url.Parse(cfg.ServerURL)
	if err != nil {
		return nil, err
	}

	scheme := "ws"
	if u.Scheme == "https" {
		scheme = "wss"
	}

	wsURL := fmt.Sprintf("%s://%s/api/probe/ws/tunnel/%s", scheme, u.Host, url.PathEscape(tunnelID))

	headers := buildWsHeaders(true)
	dialer := websocket.Dialer{HandshakeTimeout: tunnelWSDialTimeout}
	conn, _, err := dialer.Dial(wsURL, headers)
	if err != nil {
		return nil, fmt.Errorf("tunnel WS dial: %w", err)
	}

	return conn, nil
}

// wsSendTunnelReady notifies the server via the control channel.
func wsSendTunnelReady(tunnelID string) error {
	return wsSendCurrent(map[string]string{"type": "tunnel_ready", "tunnelId": tunnelID})
}

// wsSendTunnelError notifies the server of a tunnel failure via the control channel.
func wsSendTunnelError(tunnelID, errMsg string) {
	if err := wsSendCurrent(map[string]string{"type": "tunnel_error", "tunnelId": tunnelID, "error": errMsg}); err != nil {
		log.Printf("Tunnel %s: could not send tunnel_error: %v", tunnelID, err)
	}
}
