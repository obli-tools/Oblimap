package main

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// ─── Device Checks: compiled limits and local policy ─────────────────────────
//
// The hard limits below are compiled into the probe. The server cannot raise
// them: Apply rejects any rule that exceeds them and every result for that
// rule reports policy_denied. The local policy (config.json "deviceChecks",
// written by the operator, never by the server) can only tighten them.

const (
	chkMaxTargets       = 64
	chkMinInterval      = 30 * time.Second
	chkMaxTimeout       = 10 * time.Second
	chkMaxBody          = 512 << 10
	chkMaxHeaderBytes   = 32 << 10
	chkMaxConcurrency   = 4
	chkMaxRunsPerMinute = 120 // global token bucket
	chkMaxRedirects     = 3
	chkMaxVariants      = 4
	chkMaxFields        = 12
	chkMaxValueLen      = 256
	chkMaxPatternLen    = 512
	chkMaxBatch         = 100
	chkRingSize         = 500

	// Contract limits (DEVICE_CHECK_LIMITS in shared/src/deviceChecks.ts).
	chkMaxInterval     = 3600 * time.Second
	chkMaxJitter       = 60 * time.Second
	chkMinTimeout      = 1 * time.Second
	chkMinBody         = 1 << 10
	chkDefaultBody     = 256 << 10
	chkMaxExtractors   = 12
	chkMaxTransforms   = 6
	chkMaxMapEntries   = 32
	chkMaxRegexTests   = 10
	chkMaxExpectStatus = 5
	chkMaxPathLen      = 512
	chkMaxIDLen        = 64
	chkMaxMapKeyLen    = 256
)

// LocalChecksPolicy is the optional "deviceChecks" object of config.json. It
// is only ever read from disk (the server never writes it) and can only
// tighten the compiled limits. A site that refuses the feature sets
// "deviceChecks": {"enabled": false}.
type LocalChecksPolicy struct {
	Enabled               *bool `json:"enabled,omitempty"`               // false => never run
	MaxConcurrency        int   `json:"maxConcurrency,omitempty"`        // min(server, local, 4)
	MinIntervalSeconds    int   `json:"minIntervalSeconds,omitempty"`    // max(server, local, 30)
	AllowedPorts          []int `json:"allowedPorts,omitempty"`          // intersection; empty = no local restriction
	AllowPlaintextSecrets bool  `json:"allowPlaintextSecrets,omitempty"` // default false
}

// checkLimits is the effective policy for one applied config.
type checkLimits struct {
	enabled               bool
	maxConcurrency        int
	minInterval           time.Duration
	allowedPorts          map[int]bool // nil = no local restriction
	allowPlaintextSecrets bool
}

// localChecksPolicy returns the local policy of config.json (nil when absent).
// cfg.DeviceChecks is set once by loadConfig, before any goroutine starts, and
// never written afterwards.
func localChecksPolicy() *LocalChecksPolicy {
	return cfg.DeviceChecks
}

// effectiveLimits combines the compiled limits, the local policy and the
// server's maxConcurrency.
func effectiveLimits(local *LocalChecksPolicy, serverMaxConcurrency int) checkLimits {
	lim := checkLimits{
		enabled:        true,
		maxConcurrency: serverMaxConcurrency,
		minInterval:    chkMinInterval,
	}
	if lim.maxConcurrency <= 0 {
		lim.maxConcurrency = 1
	}
	if lim.maxConcurrency > chkMaxConcurrency {
		lim.maxConcurrency = chkMaxConcurrency
	}
	if local == nil {
		return lim
	}
	if local.Enabled != nil && !*local.Enabled {
		lim.enabled = false
	}
	if local.MaxConcurrency > 0 && local.MaxConcurrency < lim.maxConcurrency {
		lim.maxConcurrency = local.MaxConcurrency
	}
	if d := time.Duration(local.MinIntervalSeconds) * time.Second; d > lim.minInterval {
		lim.minInterval = d
	}
	if len(local.AllowedPorts) > 0 {
		lim.allowedPorts = make(map[int]bool, len(local.AllowedPorts))
		for _, p := range local.AllowedPorts {
			if p >= 1 && p <= 65535 {
				lim.allowedPorts[p] = true
			}
		}
	}
	lim.allowPlaintextSecrets = local.AllowPlaintextSecrets
	return lim
}

// secretsTransportAllowed reports whether target credentials may be used:
// only when the probe talks to its server over https, unless the local policy
// explicitly allows plaintext secrets.
func secretsTransportAllowed(lim checkLimits) bool {
	if lim.allowPlaintextSecrets {
		return true
	}
	return serverScheme() == "https"
}

// serverScheme returns "http" or "https" from the configured server URL, or
// "" when it is neither.
func serverScheme() string {
	u, err := url.Parse(cfg.ServerURL)
	if err != nil {
		return ""
	}
	switch s := strings.ToLower(u.Scheme); s {
	case "http", "https":
		return s
	}
	return ""
}

// checkTargetGuard validates a check target before any I/O. It is
// allowedLanTarget (lan_target.go); tests substitute it to reach a local
// listener.
var checkTargetGuard = allowedLanTarget

// ─── Rule validation ─────────────────────────────────────────────────────────

var (
	chkPathRe       = regexp.MustCompile(`^/[^\s\\#]{0,511}$`)
	chkFieldKeyRe   = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,31}$`)
	chkVariantIDRe  = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)
	chkHeaderNameRe = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$")
)

var (
	chkAccepts   = map[string]bool{"text/html": true, "application/json": true, "application/xml": true, "text/plain": true, "*/*": true}
	chkCharsets  = map[string]bool{"auto": true, "utf-8": true, "iso-8859-1": true, "windows-1252": true}
	chkTransOps  = map[string]bool{"trim": true, "collapseSpaces": true, "htmlUnescape": true, "stripTags": true, "lowercase": true, "uppercase": true, "toNumber": true, "map": true, "truncate": true, "default": true}
	chkValueType = map[string]bool{"string": true, "number": true, "boolean": true, "enum": true}
)

// validatePath checks a request path (with its optional query string) before
// it is appended to "scheme://ip:port". It must match ^/[^\s\\#]{0,511}$,
// must not start with "//" and must not contain "://", "@", "..", a
// backslash, "//" or a control character, neither as sent nor after
// percent-decoding (up to three rounds, so double encoding cannot hide them).
func validatePath(p string) error {
	if len(p) > chkMaxPathLen {
		return fmt.Errorf("path longer than %d characters", chkMaxPathLen)
	}
	if !chkPathRe.MatchString(p) {
		return fmt.Errorf("path must start with / and contain no whitespace, backslash or #")
	}
	cur := p
	for round := 0; round < 4; round++ {
		if err := pathForbidden(cur); err != nil {
			return err
		}
		dec, err := url.PathUnescape(cur)
		if err != nil {
			return fmt.Errorf("path has an invalid percent-encoding")
		}
		if dec == cur {
			return nil
		}
		cur = dec
	}
	return fmt.Errorf("path is percent-encoded too many times")
}

func pathForbidden(p string) error {
	if strings.HasPrefix(p, "//") {
		return fmt.Errorf("path must not start with //")
	}
	for _, bad := range []string{"://", "@", "..", "\\", "//"} {
		if strings.Contains(p, bad) {
			return fmt.Errorf("path must not contain %q", bad)
		}
	}
	for i := 0; i < len(p); i++ {
		if c := p[i]; c < 0x20 || c == 0x7f {
			return fmt.Errorf("path must not contain control characters")
		}
	}
	return nil
}

// validateRuleLimits checks a wire rule against the compiled limits and the
// local policy. A non-nil error means every result of the rule reports
// policy_denied. Regex compilation is checked separately (regex_compile).
// The rule id is not checked here: Apply ignores rules without a positive
// id, while Test accepts an unsaved draft (id 0).
func validateRuleLimits(r *CheckRule, lim checkLimits) error {
	if !lim.enabled {
		return fmt.Errorf("device checks are disabled by the local probe policy")
	}
	s := r.Schedule
	interval := time.Duration(s.IntervalSeconds) * time.Second
	if interval < chkMinInterval || interval > chkMaxInterval {
		return fmt.Errorf("interval %ds outside %d-%ds", s.IntervalSeconds, int(chkMinInterval/time.Second), int(chkMaxInterval/time.Second))
	}
	if j := time.Duration(s.JitterSeconds) * time.Second; j < 0 || j > chkMaxJitter {
		return fmt.Errorf("jitter %ds outside 0-%ds", s.JitterSeconds, int(chkMaxJitter/time.Second))
	}
	if t := time.Duration(s.TimeoutMs) * time.Millisecond; t < chkMinTimeout || t > chkMaxTimeout {
		return fmt.Errorf("timeout %dms outside %d-%dms", s.TimeoutMs, chkMinTimeout.Milliseconds(), chkMaxTimeout.Milliseconds())
	}

	if len(r.Fields) == 0 || len(r.Fields) > chkMaxFields {
		return fmt.Errorf("rule must declare 1-%d fields", chkMaxFields)
	}
	fields := make(map[string]bool, len(r.Fields))
	for _, f := range r.Fields {
		if !chkFieldKeyRe.MatchString(f.Key) {
			return fmt.Errorf("invalid field key")
		}
		if fields[f.Key] {
			return fmt.Errorf("duplicate field %q", f.Key)
		}
		fields[f.Key] = true
		if !chkValueType[f.ValueType] {
			return fmt.Errorf("field %q: invalid valueType", f.Key)
		}
		if f.MaxLength < 0 || f.MaxLength > chkMaxValueLen {
			return fmt.Errorf("field %q: maxLength above %d", f.Key, chkMaxValueLen)
		}
		if len(f.EnumValues) > chkMaxFields {
			return fmt.Errorf("field %q: too many enum values", f.Key)
		}
	}

	if len(r.Variants) == 0 || len(r.Variants) > chkMaxVariants {
		return fmt.Errorf("rule must declare 1-%d variants", chkMaxVariants)
	}
	variantIDs := make(map[string]bool, len(r.Variants))
	for i := range r.Variants {
		v := &r.Variants[i]
		if !chkVariantIDRe.MatchString(v.ID) || variantIDs[v.ID] {
			return fmt.Errorf("invalid or duplicate variant id")
		}
		variantIDs[v.ID] = true
		if err := validateRequest(&v.Request, lim); err != nil {
			return fmt.Errorf("variant %s: %v", v.ID, err)
		}
		if len(v.Extract) == 0 || len(v.Extract) > chkMaxExtractors {
			return fmt.Errorf("variant %s: 1-%d extractors", v.ID, chkMaxExtractors)
		}
		for j := range v.Extract {
			if err := validateExtractorLimits(&v.Extract[j], fields); err != nil {
				return fmt.Errorf("variant %s: %v", v.ID, err)
			}
		}
	}

	if len(r.RegexTests) > chkMaxRegexTests {
		return fmt.Errorf("more than %d regex tests", chkMaxRegexTests)
	}
	testIDs := make(map[string]bool, len(r.RegexTests))
	for _, t := range r.RegexTests {
		if t.ID == "" || len(t.ID) > chkMaxIDLen || testIDs[t.ID] {
			return fmt.Errorf("invalid or duplicate regex test id")
		}
		testIDs[t.ID] = true
		if !fields[t.Field] {
			return fmt.Errorf("regex test %s: unknown field", truncate(t.ID, 32))
		}
		if t.Pattern == "" || len(t.Pattern) > chkMaxPatternLen {
			return fmt.Errorf("regex test %s: pattern empty or longer than %d", truncate(t.ID, 32), chkMaxPatternLen)
		}
	}
	return nil
}

func validateRequest(q *CheckRequest, lim checkLimits) error {
	if q.Scheme != "http" && q.Scheme != "https" {
		return fmt.Errorf("scheme must be http or https")
	}
	if q.Port < 1 || q.Port > 65535 {
		return fmt.Errorf("invalid port")
	}
	if lim.allowedPorts != nil && !lim.allowedPorts[q.Port] {
		return fmt.Errorf("port %d not allowed by the local probe policy", q.Port)
	}
	if q.Method != http.MethodGet && q.Method != http.MethodHead {
		return fmt.Errorf("method must be GET or HEAD")
	}
	if err := validatePath(q.Path); err != nil {
		return err
	}
	if q.Accept != "" && !chkAccepts[q.Accept] {
		return fmt.Errorf("unsupported accept value")
	}
	if q.Auth != "" && q.Auth != "none" && q.Auth != "basic" {
		return fmt.Errorf("auth must be none or basic")
	}
	if q.MaxBodyBytes != 0 && (q.MaxBodyBytes < chkMinBody || q.MaxBodyBytes > chkMaxBody) {
		return fmt.Errorf("maxBodyBytes outside %d-%d", chkMinBody, chkMaxBody)
	}
	if q.FollowRedirects < 0 || q.FollowRedirects > chkMaxRedirects {
		return fmt.Errorf("followRedirects outside 0-%d", chkMaxRedirects)
	}
	if len(q.ExpectStatus) > chkMaxExpectStatus {
		return fmt.Errorf("more than %d expected statuses", chkMaxExpectStatus)
	}
	for _, st := range q.ExpectStatus {
		if st < 100 || st > 599 {
			return fmt.Errorf("expected status outside 100-599")
		}
	}
	if q.Charset != "" && !chkCharsets[q.Charset] {
		return fmt.Errorf("unsupported charset")
	}
	return nil
}

func validateExtractorLimits(e *CheckExtractor, fields map[string]bool) error {
	if !fields[e.Field] {
		return fmt.Errorf("extractor for an undeclared field")
	}
	switch e.Type {
	case "regex":
		if e.Pattern == "" || len(e.Pattern) > chkMaxPatternLen {
			return fmt.Errorf("field %s: pattern empty or longer than %d", e.Field, chkMaxPatternLen)
		}
		if e.Group < 0 || e.Group > 99 {
			return fmt.Errorf("field %s: invalid group", e.Field)
		}
		switch e.Source {
		case "", "body":
		case "header":
			if !chkHeaderNameRe.MatchString(e.Header) {
				return fmt.Errorf("field %s: invalid header name", e.Field)
			}
		default:
			return fmt.Errorf("field %s: source must be body or header", e.Field)
		}
	case "json":
		if _, err := parseJSONPath(e.Path); err != nil {
			return fmt.Errorf("field %s: %v", e.Field, err)
		}
	case "xml":
		if _, err := parseXMLPath(e.Path); err != nil {
			return fmt.Errorf("field %s: %v", e.Field, err)
		}
	case "httpStatus", "durationMs":
	default:
		return fmt.Errorf("field %s: unknown extractor type", e.Field)
	}
	if len(e.Transforms) > chkMaxTransforms {
		return fmt.Errorf("field %s: more than %d transforms", e.Field, chkMaxTransforms)
	}
	for _, t := range e.Transforms {
		if !chkTransOps[t.Op] {
			return fmt.Errorf("field %s: unknown transform", e.Field)
		}
		switch t.Op {
		case "map":
			if len(t.Values) > chkMaxMapEntries {
				return fmt.Errorf("field %s: map has more than %d entries", e.Field, chkMaxMapEntries)
			}
			for k, v := range t.Values {
				if len(k) > chkMaxMapKeyLen || len(v) > chkMaxMapKeyLen {
					return fmt.Errorf("field %s: map entry too long", e.Field)
				}
			}
			if t.Default != nil && len(*t.Default) > chkMaxMapKeyLen {
				return fmt.Errorf("field %s: map default too long", e.Field)
			}
		case "truncate":
			if t.Max < 1 || t.Max > chkMaxValueLen {
				return fmt.Errorf("field %s: truncate max outside 1-%d", e.Field, chkMaxValueLen)
			}
		case "default":
			if t.Value != nil && len(*t.Value) > chkMaxMapKeyLen {
				return fmt.Errorf("field %s: default value too long", e.Field)
			}
		}
	}
	return nil
}
