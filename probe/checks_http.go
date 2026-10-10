package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

// ─── Device Checks: bound HTTP client ────────────────────────────────────────
//
// One client per run, bound to one target: the URL is an IP literal (no DNS),
// no proxy (never ProxyFromEnvironment), a dialer that refuses any address
// but ip:port, redirects only to the same ip / port / scheme, no keep-alive,
// no decompression, capped headers and body, and a MAC check after the TCP
// connect and before any byte is written.

// checkHTTPRequest is one HTTP attempt (one variant) against one target.
type checkHTTPRequest struct {
	ip      string
	mac     string // normalized "AA:BB:CC:DD:EE:FF", "" when the target has no MAC
	req     *CheckRequest
	timeout time.Duration
	creds   *CheckCredentials // nil: no Authorization header
}

// httpOutcome is the response of one attempt.
type httpOutcome struct {
	status      int
	header      http.Header
	body        string // decoded to UTF-8; empty for HEAD
	bytes       int64  // raw body bytes read (at most maxBodyBytes)
	truncated   bool
	contentType string
	charset     string // decoding applied
	duration    time.Duration
	macVerified bool // every connection was MAC-verified after connect
}

// arpLookupFreshFn is arpLookupFresh (arp_cache.go); tests substitute it.
var arpLookupFreshFn = arpLookupFresh

// verifyMacAfterConnect re-reads the ARP entry of ip once the TCP connection
// exists (the kernel has just resolved it) and before any byte is sent.
// A different MAC → mac_mismatch. No entry: with credentials → mac_unverified
// (the password is never sent to an unverified host); without → unverified.
func verifyMacAfterConnect(ip, wantMac string, hasCreds bool) (bool, error) {
	if wantMac == "" {
		if hasCreds {
			return false, newCheckErr(chkErrMacUnverified, "credentials require a MAC-bound target")
		}
		return false, nil
	}
	got, ok := arpLookupFreshFn(ip)
	if ok && got != wantMac {
		return false, newCheckErr(chkErrMacMismatch, "the device answering on "+ip+" has another MAC address")
	}
	if !ok {
		if hasCreds {
			return false, newCheckErr(chkErrMacUnverified, "MAC address of "+ip+" could not be verified; credentials not sent")
		}
		return false, nil
	}
	return true, nil
}

// legacyTLSCipherSuites are TLS 1.0-1.2 suites of old embedded web servers
// (RSA key exchange, 3DES) that Go no longer enables by default. They are
// offered only when the rule explicitly sets tlsSkipVerify (the operator has
// already accepted an unauthenticated TLS peer). RC4 is never offered.
var legacyTLSCipherSuites = func() []uint16 {
	var ids []uint16
	for _, s := range tls.CipherSuites() {
		ids = append(ids, s.ID)
	}
	for _, s := range tls.InsecureCipherSuites() {
		if strings.Contains(s.Name, "RC4") {
			continue
		}
		ids = append(ids, s.ID)
	}
	return ids
}()

// newCheckTransport builds the pinned transport of one attempt. macVerified is
// updated by the dialer (false as soon as one connection is not verified).
func newCheckTransport(r *checkHTTPRequest, addr string, macState *macDialState) *http.Transport {
	hasCreds := r.creds != nil
	dial := func(ctx context.Context, _, a string) (net.Conn, error) {
		if a != addr {
			// Redirects and bugs cannot escape the bound target.
			return nil, newCheckErr(chkErrTargetNotAllowed, "connection to an address other than the target refused")
		}
		c, err := (&net.Dialer{Timeout: r.timeout}).DialContext(ctx, "tcp4", addr)
		if err != nil {
			return nil, err
		}
		verified, err := verifyMacAfterConnect(r.ip, r.mac, hasCreds)
		if err != nil {
			c.Close()
			return nil, err
		}
		macState.record(verified)
		return c, nil
	}

	tlsCfg := &tls.Config{
		InsecureSkipVerify: r.req.TLSSkipVerify, // only when the rule says so
		MinVersion:         tls.VersionTLS10,    // old embedded TLS stacks
	}
	if r.req.TLSSkipVerify {
		tlsCfg.CipherSuites = legacyTLSCipherSuites
	}
	handshake := 3 * time.Second
	if r.timeout < handshake {
		handshake = r.timeout
	}
	return &http.Transport{
		Proxy:                  nil, // NEVER ProxyFromEnvironment
		DialContext:            dial,
		DisableKeepAlives:      true,
		DisableCompression:     true,
		ForceAttemptHTTP2:      false,
		TLSNextProto:           map[string]func(string, *tls.Conn) http.RoundTripper{},
		TLSHandshakeTimeout:    handshake,
		ResponseHeaderTimeout:  r.timeout,
		MaxResponseHeaderBytes: chkMaxHeaderBytes,
		TLSClientConfig:        tlsCfg,
	}
}

// macDialState collects the MAC verification of every connection of one
// attempt (the first request and its redirects).
type macDialState struct {
	mu       sync.Mutex
	dials    int
	verified bool
}

func (s *macDialState) record(verified bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dials == 0 {
		s.verified = verified
	} else {
		s.verified = s.verified && verified
	}
	s.dials++
}

func (s *macDialState) allVerified() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dials > 0 && s.verified
}

// checkRedirectPolicy follows at most req.FollowRedirects redirects, and only
// to the same IP, port and scheme; anything else returns the redirect itself.
func checkRedirectPolicy(ip string, q *CheckRequest) func(*http.Request, []*http.Request) error {
	port := strconv.Itoa(q.Port)
	return func(r *http.Request, via []*http.Request) error {
		if len(via) > q.FollowRedirects || len(via) > chkMaxRedirects {
			return http.ErrUseLastResponse
		}
		if r.URL.User != nil || r.URL.Scheme != q.Scheme || r.URL.Hostname() != ip || effectivePort(r.URL) != port {
			return http.ErrUseLastResponse
		}
		return nil
	}
}

// effectivePort returns the explicit port of u, or the scheme default.
func effectivePort(u *url.URL) string {
	if p := u.Port(); p != "" {
		return p
	}
	switch u.Scheme {
	case "https":
		return "443"
	case "http":
		return "80"
	}
	return ""
}

// doCheckHTTP performs one attempt. ctx bounds the whole attempt.
func doCheckHTTP(ctx context.Context, r *checkHTTPRequest) (*httpOutcome, *checkErr) {
	q := r.req
	if err := validatePath(q.Path); err != nil {
		return nil, newCheckErr(chkErrPolicyDenied, err.Error())
	}
	addr := net.JoinHostPort(r.ip, strconv.Itoa(q.Port))
	macState := &macDialState{}
	tr := newCheckTransport(r, addr, macState)
	defer tr.CloseIdleConnections()
	client := &http.Client{
		Transport:     tr,
		Timeout:       r.timeout,
		CheckRedirect: checkRedirectPolicy(r.ip, q),
	}

	method := q.Method
	if method == "" {
		method = http.MethodGet
	}
	u := q.Scheme + "://" + addr + q.Path // IP literal, no DNS; path validated above
	hreq, err := http.NewRequestWithContext(ctx, method, u, nil)
	if err != nil || hreq.URL.Host != addr {
		return nil, newCheckErr(chkErrPolicyDenied, "request URL rejected")
	}
	accept := q.Accept
	if accept == "" {
		accept = "*/*"
	}
	hreq.Header.Set("User-Agent", "Oblimap-Probe/"+ProbeVersion)
	hreq.Header.Set("Accept", accept)
	hreq.Header.Set("Connection", "close")
	hreq.Close = true
	if r.creds != nil {
		hreq.SetBasicAuth(r.creds.Username, r.creds.Password)
	}

	start := time.Now()
	resp, err := client.Do(hreq)
	if err != nil {
		return nil, classifyCheckHTTPError(err)
	}
	defer resp.Body.Close()

	out := &httpOutcome{
		status:      resp.StatusCode,
		header:      resp.Header,
		contentType: resp.Header.Get("Content-Type"),
		macVerified: macState.allVerified(),
	}
	if method != http.MethodHead {
		max := q.MaxBodyBytes
		if max <= 0 {
			max = chkDefaultBody
		}
		if max > chkMaxBody {
			max = chkMaxBody
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, int64(max)+1))
		if err != nil {
			return nil, classifyCheckHTTPError(err)
		}
		if len(raw) > max {
			raw = raw[:max]
			out.truncated = true
		}
		out.bytes = int64(len(raw))
		out.body, out.charset = decodeBody(raw, out.contentType, q.Charset, out.truncated)
	}
	out.duration = time.Since(start)
	return out, nil
}

// classifyCheckHTTPError maps a transport error to a ProbeCheckErrorCode.
func classifyCheckHTTPError(err error) *checkErr {
	var ce *checkErr
	if errors.As(err, &ce) {
		return ce
	}
	msg := sanitizeErrMessage(err.Error())
	lower := strings.ToLower(msg)

	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) ||
		errnoIs(err, syscall.ETIMEDOUT, wsaETIMEDOUT) {
		return newCheckErr(chkErrTimeout, msg)
	}
	var recErr tls.RecordHeaderError
	var verifyErr *tls.CertificateVerificationError
	var alertErr tls.AlertError
	var unknownAuth x509.UnknownAuthorityError
	var hostErr x509.HostnameError
	var invalidErr x509.CertificateInvalidError
	if errors.As(err, &recErr) || errors.As(err, &verifyErr) || errors.As(err, &alertErr) ||
		errors.As(err, &unknownAuth) || errors.As(err, &hostErr) || errors.As(err, &invalidErr) ||
		strings.Contains(lower, "tls:") || strings.Contains(lower, "x509:") ||
		strings.Contains(lower, "http response to https client") {
		return newCheckErr(chkErrTLS, msg)
	}
	if errnoIs(err, syscall.ECONNREFUSED, wsaECONNREFUSED) || strings.Contains(lower, "connection refused") ||
		strings.Contains(lower, "actively refused") {
		return newCheckErr(chkErrConnRefused, msg)
	}
	return newCheckErr(chkErrUnreachable, msg)
}

// Winsock error numbers (Windows reports connect failures with these, and
// with localized messages, so the text cannot be relied upon).
const (
	wsaETIMEDOUT    = 10060
	wsaECONNREFUSED = 10061
)

// errnoIs reports whether err wraps the POSIX errno unixErrno or, on Windows,
// the Winsock error wsaErrno.
func errnoIs(err error, unixErrno syscall.Errno, wsaErrno uintptr) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	if runtime.GOOS == "windows" {
		return uintptr(errno) == wsaErrno
	}
	return errno == unixErrno
}

// sanitizeErrMessage keeps error text safe to report: printable characters
// only, at most 200 bytes. Transport errors contain the URL (IP literal and
// rule path), never credentials (they travel in a header).
func sanitizeErrMessage(s string) string {
	s = stripControls(s)
	return capString(s, 200)
}

// ─── Body decoding ───────────────────────────────────────────────────────────

// cp1252High maps the bytes 0x80-0x9F of Windows-1252 (the five undefined
// bytes keep their C1 code point, as in the WHATWG Encoding Standard).
var cp1252High = [32]rune{
	0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
	0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
	0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
	0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
}

// latin9Diff lists the eight code points where ISO-8859-15 differs from
// ISO-8859-1.
var latin9Diff = map[byte]rune{
	0xA4: 0x20AC, 0xA6: 0x0160, 0xA8: 0x0161, 0xB4: 0x017D,
	0xB8: 0x017E, 0xBC: 0x0152, 0xBD: 0x0153, 0xBE: 0x0178,
}

// decodeCP1252 decodes Windows-1252. It is also used for ISO-8859-1: like
// browsers (WHATWG), the label iso-8859-1 is decoded as its Windows-1252
// superset, since devices labelled Latin-1 routinely emit ’ “ ” € in 0x80-0x9F.
func decodeCP1252(raw []byte) string {
	var b strings.Builder
	b.Grow(len(raw) + len(raw)/4)
	for _, c := range raw {
		switch {
		case c < 0x80:
			b.WriteByte(c)
		case c < 0xA0:
			b.WriteRune(cp1252High[c-0x80])
		default:
			b.WriteRune(rune(c))
		}
	}
	return b.String()
}

// decodeLatin9 decodes ISO-8859-15.
func decodeLatin9(raw []byte) string {
	var b strings.Builder
	b.Grow(len(raw) + len(raw)/4)
	for _, c := range raw {
		if c < 0x80 {
			b.WriteByte(c)
			continue
		}
		if r, ok := latin9Diff[c]; ok {
			b.WriteRune(r)
			continue
		}
		b.WriteRune(rune(c))
	}
	return b.String()
}

var (
	utf8BOM      = []byte{0xEF, 0xBB, 0xBF}
	metaCharset  = regexp.MustCompile(`(?i)<meta[^>]{0,256}?charset\s*=\s*["']?\s*([A-Za-z0-9._:-]{1,40})`)
	xmlEncoding  = regexp.MustCompile(`(?i)<\?xml[^>]{0,256}?encoding\s*=\s*["']([A-Za-z0-9._:-]{1,40})`)
	ctCharsetRaw = regexp.MustCompile(`(?i)charset\s*=\s*["']?([A-Za-z0-9._:-]{1,40})`)
)

// normalizeCharset maps a charset label to "utf-8", "windows-1252",
// "iso-8859-15" or "" (unknown / unsupported).
func normalizeCharset(label string) string {
	switch strings.ToLower(strings.Trim(strings.TrimSpace(label), `"'`)) {
	case "utf-8", "utf8", "unicode-1-1-utf-8":
		return "utf-8"
	case "iso-8859-1", "iso8859-1", "iso_8859-1", "iso_8859-1:1987", "latin1", "latin-1", "l1",
		"cp819", "ibm819", "iso-ir-100", "csisolatin1", "us-ascii", "ascii",
		"windows-1252", "cp1252", "x-cp1252":
		return "windows-1252"
	case "iso-8859-15", "iso8859-15", "iso_8859-15", "latin9", "latin-9", "l9":
		return "iso-8859-15"
	}
	return ""
}

// charsetFromContentType returns the charset parameter of a Content-Type.
func charsetFromContentType(ct string) string {
	if ct == "" {
		return ""
	}
	if _, params, err := mime.ParseMediaType(ct); err == nil {
		return params["charset"]
	}
	if m := ctCharsetRaw.FindStringSubmatch(ct); m != nil {
		return m[1]
	}
	return ""
}

// sniffCharset looks for <meta charset>, <meta http-equiv … charset=> or an
// XML declaration encoding in the first KiB of the body.
func sniffCharset(raw []byte) string {
	head := raw
	if len(head) > 1024 {
		head = head[:1024]
	}
	if m := metaCharset.FindSubmatch(head); m != nil {
		return string(m[1])
	}
	if m := xmlEncoding.FindSubmatch(head); m != nil {
		return string(m[1])
	}
	return ""
}

// trimIncompleteUTF8Tail drops a multi-byte UTF-8 sequence cut by the body
// limit, so a truncated UTF-8 body is not mistaken for another charset.
func trimIncompleteUTF8Tail(b []byte) []byte {
	for i := 1; i <= 3 && i <= len(b); i++ {
		c := b[len(b)-i]
		if c < 0x80 {
			return b // ASCII: nothing cut
		}
		if utf8.RuneStart(c) {
			if !utf8.FullRune(b[len(b)-i:]) {
				return b[:len(b)-i]
			}
			return b
		}
	}
	return b
}

// decodeBody converts a response body to UTF-8. mode is the rule's charset:
// "utf-8" (invalid bytes replaced), "iso-8859-1" / "windows-1252" (decoded
// through the Windows-1252 table), or "auto": the Content-Type charset, then
// <meta charset> / the XML declaration in the first KiB; a Latin-1 / CP1252 /
// Latin-9 label is converted, and a body that is not valid UTF-8 whatever its
// label is decoded as Windows-1252 (so French accents in titles survive).
// truncated tells that the body was cut at maxBodyBytes: a UTF-8 sequence cut
// at the end is then dropped instead of making the whole body invalid.
// Returns the text and the decoding applied.
func decodeBody(raw []byte, contentType, mode string, truncated bool) (string, string) {
	utf8Part := func(b []byte) []byte {
		if truncated {
			return trimIncompleteUTF8Tail(b)
		}
		return b
	}
	if bytes.HasPrefix(raw, utf8BOM) {
		return strings.ToValidUTF8(string(utf8Part(raw[len(utf8BOM):])), string(utf8.RuneError)), "utf-8"
	}
	switch mode {
	case "utf-8":
		return strings.ToValidUTF8(string(utf8Part(raw)), string(utf8.RuneError)), "utf-8"
	case "iso-8859-1", "windows-1252":
		return decodeCP1252(raw), "windows-1252"
	}
	label := charsetFromContentType(contentType)
	if label == "" {
		label = sniffCharset(raw)
	}
	switch normalizeCharset(label) {
	case "windows-1252":
		return decodeCP1252(raw), "windows-1252"
	case "iso-8859-15":
		return decodeLatin9(raw), "iso-8859-15"
	}
	if valid := utf8Part(raw); utf8.Valid(valid) {
		return string(valid), "utf-8"
	}
	return decodeCP1252(raw), "windows-1252"
}

// snippetContentType reports whether a body may be previewed in a test
// result: text, JSON or XML only (sniffed when the header is missing).
func snippetContentType(contentType, body string) bool {
	ct := contentType
	if ct == "" {
		sample := body
		if len(sample) > 512 {
			sample = sample[:512]
		}
		ct = http.DetectContentType([]byte(sample))
	}
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil {
		mt = strings.ToLower(strings.TrimSpace(strings.SplitN(ct, ";", 2)[0]))
	}
	switch {
	case strings.HasPrefix(mt, "text/"),
		mt == "application/json", strings.HasSuffix(mt, "+json"),
		mt == "application/xml", strings.HasSuffix(mt, "+xml"),
		mt == "application/xhtml+xml":
		return true
	}
	return false
}
