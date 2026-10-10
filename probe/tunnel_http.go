package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// ─── Tunnel HTTP relay (capability tunnel_http:1) ───────────────────────────
//
// The legacy tunnel carries ONE raw TCP stream: the server wrote one HTTP
// request into it, so only the top-level page of a device loaded, every
// sub-resource found a closed relay, and an HTTPS-only port received plain
// HTTP. In HTTP relay mode the probe is an HTTP client pinned to the tunnel's
// target IP and the data WebSocket multiplexes independent request streams:
//
//	server → probe  text   {"type":"http_req","id":N,"method","path","headers":[[k,v]],"scheme"?,"port"?}
//	                binary [4-byte big-endian id][request body chunk]
//	                text   {"type":"http_req_end","id":N}       (the request is complete: run it)
//	                text   {"type":"http_credit","id":N,"bytes":B} (flow control: the server consumed B bytes)
//	                text   {"type":"http_cancel","id":N}
//	                text   {"type":"tunnel_mode","mode":"http","scheme","hostNames"} (first message: selects this mode)
//	probe → server  text   {"type":"tunnel_hello","features":["http:1"]} (right after the data socket connects)
//	                text   {"type":"http_res","id":N,"status","headers":[[k,v]],"origin":{scheme,port},"base":{scheme,port}}
//	                binary [4-byte big-endian id][response body chunk]
//	                text   {"type":"http_end","id":N,"error"?:code,"detail"?:text}
//
// Every connection goes to the tunnel's target IP only (re-validated with
// allowedLanTarget at each dial), on the tunnel's port or on another port of
// the same IP that the device itself redirected to; never through a proxy,
// never following a redirect to another host. HTTPS targets are reached with
// certificate verification disabled — devices use self-signed certificates,
// and the IP is pinned — tolerant of old TLS versions (embedded cameras).
// A server that never sends tunnel_mode (older server) gets the legacy raw
// relay: its first binary frame selects it.

const (
	// tunnelHTTPCapability is advertised in the hello / push capabilities so
	// the server can tell, before opening, whether this probe has the relay.
	tunnelHTTPCapability = "tunnel_http:1"
	// tunnelHTTPFeature is announced in tunnel_hello on the data socket.
	tunnelHTTPFeature = "http:1"

	// The server keeps at most 16 streams in flight per tunnel; the margin
	// covers streams it cancelled that are still unwinding here.
	httpRelayMaxStreams       = 32
	httpRelayMaxRequestBody   = 8 << 20
	httpRelayMaxResponseBody  = 32 << 20
	httpRelayChunk            = 32 << 10
	httpRelayInitialWindow    = 256 << 10
	httpRelayHeaderTimeout    = 30 * time.Second
	httpRelayStallTimeout     = 60 * time.Second
	httpRelayDialTimeout      = 7 * time.Second
	httpRelayTLSProbeTimeout  = 5 * time.Second
	httpRelayWriteTimeout     = 30 * time.Second
	httpRelayMaxRedirects     = 3
	httpRelayMaxHeaders       = 100
	httpRelayMaxHeaderBytes   = 64 << 10
	httpRelayMaxPath          = 8192
	httpRelayMaxResponseHeads = 64 << 10
)

// relayOrigin is one scheme + port of the tunnel's target IP.
type relayOrigin struct {
	Scheme string `json:"scheme"`
	Port   int    `json:"port"`
}

// frameSink writes frames to the server (the tunnel data socket). Writes may
// come from several goroutines: implementations serialize them.
type frameSink interface {
	WriteText(v any) error
	WriteBinary(b []byte) error
}

// wsFrameSink is the frameSink of a gorilla WebSocket (one writer at a time).
type wsFrameSink struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (s *wsFrameSink) WriteText(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(httpRelayWriteTimeout))
	return s.conn.WriteMessage(websocket.TextMessage, data)
}

func (s *wsFrameSink) WriteBinary(b []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(httpRelayWriteTimeout))
	return s.conn.WriteMessage(websocket.BinaryMessage, b)
}

// httpRelay is the HTTP relay of one tunnel.
type httpRelay struct {
	targetIP   string
	targetPort int      // the tunnel's port (the base starts there)
	hostNames  []string // lower-case names of the device (redirect targets treated as the device)
	sink       frameSink
	// checkTarget re-validates the target before every dial (allowedLanTarget;
	// tests substitute it).
	checkTarget func(ip string) error
	touch       func()

	// Limits (fields so tests can lower them).
	maxStreams      int
	maxRequestBody  int
	maxResponseBody int64

	ctx    context.Context
	cancel context.CancelFunc

	mu         sync.Mutex
	base       relayOrigin
	schemeAuto bool // the base scheme was guessed: TLS detection may correct it
	transports map[relayOrigin]*http.Transport
	streams    map[uint32]*relayStream
}

// relayStream is one proxied request and its response.
type relayStream struct {
	id      uint32
	method  string
	path    string
	headers [][2]string
	origin  *relayOrigin // nil: the tunnel's current base origin

	body     bytes.Buffer
	tooLarge bool
	started  bool

	ctx    context.Context
	cancel context.CancelFunc

	credit   atomic.Int64
	creditCh chan struct{}
}

// defaultSchemeForPort is the scheme guessed for a port when none was chosen.
func defaultSchemeForPort(port int) string {
	switch port {
	case 443, 8443, 4443, 9443:
		return "https"
	}
	return "http"
}

// newHTTPRelay builds the relay of a tunnel to targetIP:port. scheme is
// "http", "https" or "auto" (guessed from the port, then corrected when the
// device answers otherwise).
func newHTTPRelay(targetIP string, port int, scheme string, hostNames []string, sink frameSink) *httpRelay {
	ctx, cancel := context.WithCancel(context.Background())
	r := &httpRelay{
		targetIP:        targetIP,
		targetPort:      port,
		sink:            sink,
		checkTarget:     allowedLanTarget,
		touch:           func() {},
		maxStreams:      httpRelayMaxStreams,
		maxRequestBody:  httpRelayMaxRequestBody,
		maxResponseBody: httpRelayMaxResponseBody,
		ctx:             ctx,
		cancel:          cancel,
		transports:      make(map[relayOrigin]*http.Transport),
		streams:         make(map[uint32]*relayStream),
	}
	r.hostNames = sanitizeHostNames(hostNames)
	r.setScheme(scheme)
	return r
}

// setScheme applies the scheme chosen for the tunnel (tunnel_mode): the base
// goes back to the tunnel's own port with that scheme.
func (r *httpRelay) setScheme(scheme string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.base.Port = r.targetPort
	switch scheme {
	case "http", "https":
		r.base.Scheme = scheme
		r.schemeAuto = false
	default:
		r.base.Scheme = defaultSchemeForPort(r.targetPort)
		r.schemeAuto = true
	}
}

var hostNameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*$`)

func sanitizeHostNames(names []string) []string {
	var out []string
	for _, n := range names {
		n = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(n), "."))
		if len(n) == 0 || len(n) > 253 || !hostNameRe.MatchString(n) {
			continue
		}
		out = append(out, n)
		if len(out) >= 8 {
			break
		}
	}
	return out
}

// currentBase returns the tunnel's base origin and whether its scheme was guessed.
func (r *httpRelay) currentBase() (relayOrigin, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.base, r.schemeAuto
}

// setBase moves the tunnel's base origin (device redirect http → https,
// detected TLS port). A redirect makes the choice definitive.
func (r *httpRelay) setBase(o relayOrigin, definitive bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.base = o
	if definitive {
		r.schemeAuto = false
	}
}

// close cancels every stream and drops the idle connections to the device.
func (r *httpRelay) close() {
	r.cancel()
	r.mu.Lock()
	transports := r.transports
	r.transports = make(map[relayOrigin]*http.Transport)
	for _, s := range r.streams {
		s.cancel()
	}
	r.mu.Unlock()
	for _, t := range transports {
		t.CloseIdleConnections()
	}
}

// activeStreams is the number of streams in progress (idle watchdog).
func (r *httpRelay) activeStreams() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.streams)
}

// tlsClientConfig accepts the device's certificate whatever it is (the
// target IP is pinned by the dialer) and old protocol versions / cipher
// suites still found on embedded devices. No SNI: the host is an IP literal.
func tlsClientConfig() *tls.Config {
	suites := make([]uint16, 0, 32)
	for _, s := range tls.CipherSuites() {
		suites = append(suites, s.ID)
	}
	for _, s := range tls.InsecureCipherSuites() {
		suites = append(suites, s.ID)
	}
	return &tls.Config{
		// Devices present self-signed certificates for their IP; the
		// connection can only reach the tunnel's pinned target.
		InsecureSkipVerify: true, //nolint:gosec // see above
		MinVersion:         tls.VersionTLS10,
		CipherSuites:       suites,
	}
}

// dialTarget opens a TCP connection to the tunnel's target IP on port,
// whatever address the HTTP client asked for.
func (r *httpRelay) dialTarget(ctx context.Context, port int) (net.Conn, error) {
	if err := r.checkTarget(r.targetIP); err != nil {
		return nil, err
	}
	if port < 1 || port > 65535 {
		return nil, errTargetNotAllowed
	}
	d := net.Dialer{Timeout: httpRelayDialTimeout}
	return d.DialContext(ctx, "tcp4", net.JoinHostPort(r.targetIP, strconv.Itoa(port)))
}

// transport returns the keep-alive transport of an origin of the target.
func (r *httpRelay) transport(o relayOrigin) *http.Transport {
	r.mu.Lock()
	defer r.mu.Unlock()
	if t, ok := r.transports[o]; ok {
		return t
	}
	port := o.Port
	t := &http.Transport{
		Proxy: nil, // never the environment's proxy
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return r.dialTarget(ctx, port)
		},
		TLSClientConfig:        tlsClientConfig(),
		TLSNextProto:           map[string]func(string, *tls.Conn) http.RoundTripper{}, // HTTP/1.1 only
		ForceAttemptHTTP2:      false,
		MaxIdleConns:           httpRelayMaxStreams,
		MaxIdleConnsPerHost:    8,
		MaxConnsPerHost:        httpRelayMaxStreams,
		IdleConnTimeout:        90 * time.Second,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  httpRelayHeaderTimeout,
		ExpectContinueTimeout:  time.Second,
		MaxResponseHeaderBytes: httpRelayMaxResponseHeads,
	}
	r.transports[o] = t
	return t
}

// ─── Incoming frames ────────────────────────────────────────────────────────

var (
	httpMethodRe     = regexp.MustCompile(`^[A-Z]{3,12}$`)
	httpHeaderNameRe = regexp.MustCompile(`^[!#$%&'*+.^_` + "`" + `|~0-9A-Za-z-]{1,128}$`)
)

// hopByHopHeaders are never relayed in either direction.
var hopByHopHeaders = map[string]bool{
	"connection": true, "keep-alive": true, "proxy-connection": true, "proxy-authenticate": true,
	"proxy-authorization": true, "te": true, "trailer": true, "transfer-encoding": true,
	"upgrade": true, "host": true, "content-length": true,
}

type relayFrame struct {
	Type      string      `json:"type"`
	ID        uint32      `json:"id"`
	Method    string      `json:"method"`
	Path      string      `json:"path"`
	Headers   [][2]string `json:"headers"`
	Scheme    string      `json:"scheme"`
	Port      int         `json:"port"`
	Bytes     int64       `json:"bytes"`
	Mode      string      `json:"mode"`
	HostNames []string    `json:"hostNames"`
}

// handleText processes one text frame from the server.
func (r *httpRelay) handleText(raw []byte) {
	var f relayFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		return
	}
	r.touch()
	switch f.Type {
	case "http_req":
		r.openStream(&f)
	case "http_req_end":
		if s := r.stream(f.ID); s != nil {
			r.mu.Lock()
			start := !s.started
			s.started = true
			r.mu.Unlock()
			if start {
				go r.run(s)
			}
		}
	case "http_credit":
		if s := r.stream(f.ID); s != nil && f.Bytes > 0 && f.Bytes <= 1<<30 {
			s.credit.Add(f.Bytes)
			select {
			case s.creditCh <- struct{}{}:
			default:
			}
		}
	case "http_cancel":
		if s := r.stream(f.ID); s != nil {
			s.cancel()
		}
	case "tunnel_mode":
		// A later tunnel_mode changes the scheme chosen in the dialog.
		if f.Mode == "http" {
			r.setScheme(f.Scheme)
		}
	}
}

// handleBinary processes one binary frame: a chunk of a request body.
func (r *httpRelay) handleBinary(b []byte) {
	if len(b) < 4 {
		return
	}
	r.touch()
	id := binary.BigEndian.Uint32(b[:4])
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.streams[id]
	if !ok || s.started {
		return
	}
	if s.body.Len()+len(b)-4 > r.maxRequestBody {
		s.tooLarge = true
		s.body.Reset()
		return
	}
	if !s.tooLarge {
		s.body.Write(b[4:])
	}
}

func (r *httpRelay) stream(id uint32) *relayStream {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.streams[id]
}

// openStream validates an http_req frame and registers its stream.
func (r *httpRelay) openStream(f *relayFrame) {
	if f.ID == 0 {
		return
	}
	reject := func(code string) {
		_ = r.sink.WriteText(map[string]any{"type": "http_end", "id": f.ID, "error": code})
	}
	if !httpMethodRe.MatchString(f.Method) || !validRelayPath(f.Path) || !validRelayHeaders(f.Headers) {
		reject("bad_request")
		return
	}
	var origin *relayOrigin
	if f.Scheme != "" || f.Port != 0 {
		if (f.Scheme != "http" && f.Scheme != "https") || f.Port < 1 || f.Port > 65535 {
			reject("bad_request")
			return
		}
		origin = &relayOrigin{Scheme: f.Scheme, Port: f.Port}
	}
	r.mu.Lock()
	if r.ctx.Err() != nil {
		r.mu.Unlock()
		return
	}
	if _, exists := r.streams[f.ID]; exists {
		r.mu.Unlock()
		reject("bad_request")
		return
	}
	if len(r.streams) >= r.maxStreams {
		r.mu.Unlock()
		reject("too_many_streams")
		return
	}
	ctx, cancel := context.WithCancel(r.ctx)
	s := &relayStream{
		id:       f.ID,
		method:   f.Method,
		path:     f.Path,
		headers:  f.Headers,
		origin:   origin,
		ctx:      ctx,
		cancel:   cancel,
		creditCh: make(chan struct{}, 1),
	}
	s.credit.Store(httpRelayInitialWindow)
	r.streams[f.ID] = s
	r.mu.Unlock()
}

// validRelayPath: an origin-form target (path + query), visible ASCII only.
func validRelayPath(p string) bool {
	if len(p) == 0 || len(p) > httpRelayMaxPath || p[0] != '/' || strings.HasPrefix(p, "//") {
		return false
	}
	for i := 0; i < len(p); i++ {
		if p[i] < 0x21 || p[i] > 0x7e {
			return false
		}
	}
	return true
}

func validRelayHeaders(h [][2]string) bool {
	if len(h) > httpRelayMaxHeaders {
		return false
	}
	total := 0
	for _, kv := range h {
		total += len(kv[0]) + len(kv[1])
		if !httpHeaderNameRe.MatchString(kv[0]) || strings.ContainsAny(kv[1], "\r\n\x00") {
			return false
		}
	}
	return total <= httpRelayMaxHeaderBytes
}

// ─── Running a stream ───────────────────────────────────────────────────────

// relayError is a failure reported to the server as a short code (shown to
// the user as a diagnostic page) plus a detail for the log / page.
type relayError struct {
	code   string
	detail string
}

func (e *relayError) Error() string { return e.code + ": " + e.detail }

func (r *httpRelay) end(id uint32, err error) {
	msg := map[string]any{"type": "http_end", "id": id}
	if err != nil {
		var re *relayError
		if errors.As(err, &re) {
			msg["error"] = re.code
			msg["detail"] = truncateDetail(re.detail)
		} else {
			msg["error"] = classifyRelayError(err)
			msg["detail"] = truncateDetail(err.Error())
		}
	}
	_ = r.sink.WriteText(msg)
}

func truncateDetail(s string) string {
	s = strings.Map(func(c rune) rune {
		if c < 0x20 || c == 0x7f {
			return ' '
		}
		return c
	}, s)
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

// classifyRelayError maps a transport error to a diagnostic code.
func classifyRelayError(err error) string {
	var rhe tls.RecordHeaderError
	var netErr net.Error
	var errno syscall.Errno
	if errors.As(err, &errno) {
		// Windows reports WSA codes (10061 refused, 10065 / 10051 unreachable).
		switch uintptr(errno) {
		case 10061:
			return "connection_refused"
		case 10065, 10051:
			return "unreachable"
		}
	}
	switch {
	case errors.Is(err, errTargetNotAllowed):
		return "target_not_allowed"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection_refused"
	case errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH):
		return "unreachable"
	case errors.As(err, &rhe):
		return "tls_failed"
	case errors.As(err, &netErr) && netErr.Timeout():
		return "timeout"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "connection refused"), strings.Contains(msg, "actively refused"):
		return "connection_refused"
	case strings.Contains(msg, "tls:"), strings.Contains(msg, "TLS handshake"):
		return "tls_failed"
	case strings.Contains(msg, "connection reset"), strings.Contains(msg, "EOF"), strings.Contains(msg, "forcibly closed"):
		return "connection_closed"
	}
	return "request_failed"
}

// release forgets a finished stream (before its http_end is sent: the
// server may reuse the slot as soon as it reads it).
func (r *httpRelay) release(s *relayStream) {
	s.cancel()
	r.mu.Lock()
	if r.streams[s.id] == s {
		delete(r.streams, s.id)
	}
	r.mu.Unlock()
	r.touch()
}

// run executes a stream's request and streams the response to the server.
func (r *httpRelay) run(s *relayStream) {
	if s.tooLarge {
		r.release(s)
		r.end(s.id, &relayError{code: "request_too_large", detail: "request body larger than the relay accepts"})
		return
	}
	resp, origin, err := r.roundTrip(s)
	if err != nil {
		r.release(s)
		r.end(s.id, err)
		return
	}
	defer resp.Body.Close()
	base, _ := r.currentBase()
	if err := r.sink.WriteText(map[string]any{
		"type":    "http_res",
		"id":      s.id,
		"status":  resp.StatusCode,
		"headers": responseHeaderPairs(resp.Header),
		"origin":  origin,
		"base":    base,
	}); err != nil {
		r.release(s)
		return
	}
	bodyErr := r.streamBody(s, resp.Body)
	r.release(s)
	r.end(s.id, bodyErr)
}

// streamBody relays the response body in chunks, within the stream's credit.
func (r *httpRelay) streamBody(s *relayStream, body io.Reader) error {
	buf := make([]byte, httpRelayChunk)
	var total int64
	for {
		n, err := body.Read(buf)
		if n > 0 {
			total += int64(n)
			if total > r.maxResponseBody {
				return &relayError{code: "response_too_large", detail: "response larger than " + strconv.FormatInt(r.maxResponseBody>>20, 10) + " MiB"}
			}
			if !s.waitCredit(int64(n)) {
				return &relayError{code: "cancelled", detail: "stream cancelled or stalled"}
			}
			frame := make([]byte, 4+n)
			binary.BigEndian.PutUint32(frame[:4], s.id)
			copy(frame[4:], buf[:n])
			if wErr := r.sink.WriteBinary(frame); wErr != nil {
				return wErr
			}
			r.touch()
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			if s.ctx.Err() != nil {
				return &relayError{code: "cancelled", detail: "stream cancelled"}
			}
			return err
		}
	}
}

// waitCredit takes n bytes of credit, waiting for the server to consume
// earlier chunks (false: cancelled or stalled).
func (s *relayStream) waitCredit(n int64) bool {
	timer := time.NewTimer(httpRelayStallTimeout)
	defer timer.Stop()
	for {
		if c := s.credit.Load(); c >= n {
			if s.credit.CompareAndSwap(c, c-n) {
				return true
			}
			continue
		}
		select {
		case <-s.creditCh:
		case <-s.ctx.Done():
			return false
		case <-timer.C:
			return false
		}
	}
}

func responseHeaderPairs(h http.Header) [][2]string {
	out := make([][2]string, 0, len(h))
	for name, values := range h {
		if hopByHopHeaders[strings.ToLower(name)] {
			continue
		}
		for _, v := range values {
			out = append(out, [2]string{name, v})
		}
	}
	return out
}

// roundTrip runs the request against the device, following a same-device
// http → https redirect inside the relay and correcting a guessed scheme
// when the port speaks the other one. Returns the final response and the
// origin it came from.
func (r *httpRelay) roundTrip(s *relayStream) (*http.Response, relayOrigin, error) {
	base, auto := r.currentBase()
	origin := base
	explicit := s.origin != nil
	if explicit {
		origin = *s.origin
		auto = false
	}
	method, path := s.method, s.path
	body := s.body.Bytes()

	for attempt := 0; ; attempt++ {
		resp, err := r.do(s, origin, method, path, body)
		if err != nil {
			if attempt < httpRelayMaxRedirects {
				if origin.Scheme == "http" && plainRequestRefused(err) && r.speaksTLS(s.ctx, origin.Port) {
					if !auto {
						return nil, origin, &relayError{code: "tls_required", detail: "the device answers HTTPS on port " + strconv.Itoa(origin.Port)}
					}
					origin.Scheme = "https"
					if !explicit {
						r.setBase(origin, false)
					}
					continue
				}
				if origin.Scheme == "https" && auto && tlsRefusedPlainHTTP(err) {
					origin.Scheme = "http"
					if !explicit {
						r.setBase(origin, false)
					}
					continue
				}
			}
			if origin.Scheme == "https" && tlsRefusedPlainHTTP(err) {
				return nil, origin, &relayError{code: "tls_not_supported", detail: "the device answers plain HTTP on port " + strconv.Itoa(origin.Port)}
			}
			return nil, origin, err
		}

		if origin.Scheme == "http" && resp.StatusCode == http.StatusBadRequest && attempt < httpRelayMaxRedirects {
			plainToTLS, restored := peekPlainToTLSAnswer(resp)
			resp = restored
			if plainToTLS {
				resp.Body.Close()
				if !auto {
					return nil, origin, &relayError{code: "tls_required", detail: "the device answers HTTPS on port " + strconv.Itoa(origin.Port)}
				}
				origin.Scheme = "https"
				if !explicit {
					r.setBase(origin, false)
				}
				continue
			}
		}

		if isRedirectStatus(resp.StatusCode) && attempt < httpRelayMaxRedirects {
			if next, nextPath, ok := r.upgradeRedirect(origin, resp.Header.Get("Location")); ok {
				if !explicit {
					// The device asked for HTTPS: the whole tunnel moves there.
					r.setBase(next, true)
				}
				if nextPath == path {
					// Same resource over HTTPS: followed here, the browser
					// just receives the page.
					_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
					resp.Body.Close()
					if resp.StatusCode != http.StatusTemporaryRedirect && resp.StatusCode != http.StatusPermanentRedirect &&
						method != http.MethodGet && method != http.MethodHead {
						method, body = http.MethodGet, nil
					}
					origin = next
					continue
				}
				// Another path: the redirect is relayed (the server rewrites
				// its Location under the proxy prefix, now on the new base).
			}
		}
		return resp, origin, nil
	}
}

// do sends one request to an origin of the target.
func (r *httpRelay) do(s *relayStream, origin relayOrigin, method, path string, body []byte) (*http.Response, error) {
	host := r.targetIP
	if !(origin.Scheme == "http" && origin.Port == 80) && !(origin.Scheme == "https" && origin.Port == 443) {
		host = net.JoinHostPort(r.targetIP, strconv.Itoa(origin.Port))
	}
	u, err := url.Parse(origin.Scheme + "://" + host + path)
	if err != nil || u.Host != host {
		return nil, &relayError{code: "bad_request", detail: "invalid request target"}
	}
	var reader io.Reader = http.NoBody
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(s.ctx, method, u.String(), reader)
	if err != nil {
		return nil, &relayError{code: "bad_request", detail: "invalid request"}
	}
	req.URL = u
	req.Host = host
	for _, kv := range s.headers {
		if hopByHopHeaders[strings.ToLower(kv[0])] {
			continue
		}
		req.Header.Add(kv[0], kv[1])
	}
	if req.Header.Get("User-Agent") == "" {
		req.Header.Set("User-Agent", "") // no Go default User-Agent
	}
	return r.transport(origin).RoundTrip(req)
}

func isRedirectStatus(code int) bool {
	switch code {
	case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
		http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		return true
	}
	return false
}

// isDeviceHost: the host of a URL names the tunnel's device.
func (r *httpRelay) isDeviceHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == r.targetIP {
		return true
	}
	for _, n := range r.hostNames {
		if n == host {
			return true
		}
	}
	return false
}

// upgradeRedirect recognizes a redirect of an http origin to https on the
// same device (any port): returns the new origin and the redirect's path.
func (r *httpRelay) upgradeRedirect(from relayOrigin, location string) (relayOrigin, string, bool) {
	if from.Scheme != "http" || location == "" {
		return relayOrigin{}, "", false
	}
	u, err := url.Parse(strings.TrimSpace(location))
	if err != nil || !strings.EqualFold(u.Scheme, "https") || !r.isDeviceHost(u.Hostname()) {
		return relayOrigin{}, "", false
	}
	port := 443
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return relayOrigin{}, "", false
		}
		port = n
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	return relayOrigin{Scheme: "https", Port: port}, path, true
}

// plainRequestRefused: a plain HTTP request failed the way it does against
// a TLS port (TLS alert / handshake bytes as an answer, or the connection
// dropped without an answer).
func plainRequestRefused(err error) bool {
	var netErr *net.OpError
	if errors.As(err, &netErr) && netErr.Op == "dial" {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "malformed HTTP") || strings.Contains(msg, "EOF") ||
		strings.Contains(msg, "connection reset") || strings.Contains(msg, "forcibly closed")
}

// tlsRefusedPlainHTTP: a TLS handshake met a plain HTTP server.
func tlsRefusedPlainHTTP(err error) bool {
	var rhe tls.RecordHeaderError
	if errors.As(err, &rhe) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "server gave HTTP response to HTTPS client") ||
		strings.Contains(msg, "first record does not look like a TLS handshake")
}

// plainToTLSPhrases are the bodies of servers answering plain HTTP on their TLS port.
var plainToTLSPhrases = []string{
	"http request to an https server",           // Go
	"plain http request was sent to https port", // nginx
	"speaking plain http to an ssl-enabled",     // Apache
	"this combination of host and port requires tls",
	"the plain http request was sent",
}

// peekPlainToTLSAnswer reads the beginning of a 400 answer to recognize "plain
// HTTP sent to an HTTPS port"; the returned response still has its full body.
func peekPlainToTLSAnswer(resp *http.Response) (bool, *http.Response) {
	head := make([]byte, 2048)
	n, _ := io.ReadFull(resp.Body, head)
	head = head[:n]
	lower := strings.ToLower(string(head))
	match := false
	for _, p := range plainToTLSPhrases {
		if strings.Contains(lower, p) {
			match = true
			break
		}
	}
	resp.Body = struct {
		io.Reader
		io.Closer
	}{io.MultiReader(bytes.NewReader(head), resp.Body), resp.Body}
	return match, resp
}

// speaksTLS reports whether the target completes a TLS handshake on port.
func (r *httpRelay) speaksTLS(ctx context.Context, port int) bool {
	ctx, cancel := context.WithTimeout(ctx, httpRelayTLSProbeTimeout)
	defer cancel()
	conn, err := r.dialTarget(ctx, port)
	if err != nil {
		return false
	}
	defer conn.Close()
	tc := tls.Client(conn, tlsClientConfig())
	err = tc.HandshakeContext(ctx)
	return err == nil
}

// ─── Data socket ────────────────────────────────────────────────────────────

// serveHTTPRelay runs the relay of tunnel t on its data socket until the
// socket closes, the server closes the tunnel, or the relay stays idle
// (no stream, no frame) for tunnelIdleTimeout.
func serveHTTPRelay(t *activeTunnel, relay *httpRelay) {
	defer func() {
		relay.close()
		unregisterTunnel(t)
		t.cancel()
		log.Printf("Tunnel %s: HTTP relay closed", t.tunnelID)
	}()
	touch := func() { t.lastActivity.Store(time.Now().UnixNano()) }
	relay.touch = touch
	touch()

	errCh := make(chan error, 1)
	go func() {
		for {
			kind, data, err := t.wsConn.ReadMessage()
			if err != nil {
				errCh <- err
				return
			}
			switch kind {
			case websocket.TextMessage:
				relay.handleText(data)
			case websocket.BinaryMessage:
				relay.handleBinary(data)
			}
		}
	}()

	idleCheck := time.NewTicker(30 * time.Second)
	defer idleCheck.Stop()
	for {
		select {
		case <-errCh:
			return
		case <-t.done:
			return
		case <-idleCheck.C:
			if relay.activeStreams() > 0 {
				continue
			}
			idle := time.Since(time.Unix(0, t.lastActivity.Load()))
			if idle >= tunnelIdleTimeout {
				log.Printf("Tunnel %s: idle for %v — closing", t.tunnelID, idle.Round(time.Second))
				return
			}
		}
	}
}
