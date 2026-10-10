package main

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"log"
	"math/rand"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ─── Device Checks: manager and scheduler ────────────────────────────────────
//
// The CheckManager runs independently of the WebSocket session (wsRun) and of
// the scan ticker: it is created by mainLoop before the first push and keeps
// running in WS and HTTP modes. The server delivers the assignment in
// config.deviceChecks (HTTP push response, config_update); Apply is a no-op
// while the rev is unchanged, recompiles only the rules whose revision
// changed, and starts / stops only the rule:item workers that changed.
//
// Host protection: at most maxConcurrency (≤ 4) requests at once, one
// in-flight run per device, 120 runs per minute probe-wide, interval ≥ 30 s.

// checkMgr is the probe-wide manager (nil until mainLoop creates it). It is
// assigned once, before the first push and before the WebSocket starts.
var checkMgr *CheckManager

type compiledVariant struct {
	v          CheckVariant
	extractors []compiledExtractor
	expect     map[int]bool
}

type compiledTest struct {
	id    string
	field string
	re    *regexp.Regexp
}

// compiledRule is a wire rule validated against the limits, with its regexes
// and paths compiled. A rule that cannot run keeps denyCode / denyMsg: every
// result for it reports that error without any I/O.
type compiledRule struct {
	rule        CheckRule
	fingerprint uint64
	fields      []CheckField
	variants    []compiledVariant
	tests       []compiledTest
	interval    time.Duration
	jitter      time.Duration
	timeout     time.Duration
	denyCode    string
	denyMsg     string
}

// runTarget is a target prepared for execution.
type runTarget struct {
	ruleID       int
	itemID       int
	ip           string
	mac          string // normalized, "" when the target has no MAC
	macInvalid   bool
	creds        *CheckCredentials
	credsBlocked bool   // credentials refused locally (server not reached over https)
	authBlocked  string // set by the server: missing | no_key | insecure_transport
}

type checkWorker struct {
	key    string
	wire   CheckTarget // as received (credentials dropped when credsBlocked)
	target runTarget
	rule   *compiledRule
	cancel context.CancelFunc
	runNow chan struct{}

	mu            sync.Mutex // guards the fields below
	stickyVariant int
	lastStatus    string
	lastCode      string
	lastTraceAt   time.Time
}

// checkReport is a scheduled result handed to the reporter. urgent is set
// when the target's status (ok / error) changed.
type checkReport struct {
	res    CheckResult
	urgent bool
}

// CheckManager owns the workers of the current assignment.
type CheckManager struct {
	ctx context.Context

	mu      sync.Mutex // guards rev, lim, rules, workers, sem
	rev     string
	lim     checkLimits
	rules   map[int]*compiledRule
	workers map[string]*checkWorker
	sem     chan struct{}

	hosts     sync.Map // ip → *sync.Mutex (TryLock: one in-flight run per device)
	bucket    *tokenBucket
	out       chan checkReport
	testSlots chan struct{}
}

const (
	checkTraceSampleEvery = 15 * time.Minute
	checkMaxTraceSteps    = 24
	checkSnippetBytes     = 4 << 10
	checkMaxConcurrentTst = 2
	// A test must answer before the server stops waiting for it (20 s):
	// at most checkTestBudget waiting for the device lock, the rate
	// limit and a concurrency slot, and checkTestMaxDuration in all. Variants
	// that no longer fit are not tried and the result reports timeout.
	checkTestBudget      = 5 * time.Second
	checkTestMaxDuration = 18 * time.Second
)

func newCheckManager(ctx context.Context) *CheckManager {
	lim := effectiveLimits(localChecksPolicy(), 2)
	return &CheckManager{
		ctx:       ctx,
		lim:       lim,
		rules:     make(map[int]*compiledRule),
		workers:   make(map[string]*checkWorker),
		sem:       make(chan struct{}, lim.maxConcurrency),
		bucket:    newTokenBucket(chkMaxRunsPerMinute),
		out:       make(chan checkReport, 256),
		testSlots: make(chan struct{}, checkMaxConcurrentTst),
	}
}

// configured reports whether a non-empty assignment is applied.
func (m *CheckManager) configured() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rev != ""
}

// ─── Apply ───────────────────────────────────────────────────────────────────

// Apply installs the assignment received from the server. nil or empty stops
// every worker (old server, probe not approved or without site, checks
// disabled, no target). The same rev is a no-op.
func (m *CheckManager) Apply(cfg *DeviceChecksConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if cfg == nil || cfg.V != 1 || len(cfg.Rules) == 0 || len(cfg.Targets) == 0 {
		if cfg != nil && cfg.V != 1 {
			log.Printf("Device checks: unsupported config version %d — ignoring the assignment", cfg.V)
		}
		if m.rev != "" || len(m.workers) > 0 {
			log.Printf("Device checks: no assignment — stopping %d check(s)", len(m.workers))
		}
		m.stopAllLocked()
		m.rev = ""
		m.rules = make(map[int]*compiledRule)
		return
	}
	if cfg.Rev != "" && cfg.Rev == m.rev {
		return
	}

	lim := effectiveLimits(localChecksPolicy(), cfg.MaxConcurrency)
	if m.sem == nil || lim.maxConcurrency != m.lim.maxConcurrency {
		// In-flight runs release the channel they acquired.
		m.sem = make(chan struct{}, lim.maxConcurrency)
	}
	m.lim = lim

	// Rules: reuse the compiled rule when its revision and content did not change.
	// A saved rule always has a positive id (drafts only reach Test).
	newRules := make(map[int]*compiledRule, len(cfg.Rules))
	for _, r := range cfg.Rules {
		if r.ID <= 0 {
			log.Printf("Device checks: rule without a valid id ignored")
			continue
		}
		if _, dup := newRules[r.ID]; dup || len(newRules) >= chkMaxTargets {
			continue
		}
		fp := ruleFingerprint(r)
		if old, ok := m.rules[r.ID]; ok && old.rule.Rev == r.Rev && old.fingerprint == fp {
			newRules[r.ID] = old
			continue
		}
		cr := compileRule(r, lim)
		if cr.denyCode != "" {
			log.Printf("Device checks: rule %d rev %d refused (%s): %s", r.ID, r.Rev, cr.denyCode, cr.denyMsg)
		}
		newRules[r.ID] = cr
	}

	// Targets: at most chkMaxTargets, first occurrence of each rule:item.
	want := make(map[string]CheckTarget, len(cfg.Targets))
	var order []string
	dropped := 0
	for _, t := range cfg.Targets {
		if t.RuleID <= 0 || t.ItemID <= 0 || newRules[t.RuleID] == nil {
			dropped++
			continue
		}
		key := checkKey(t.RuleID, t.ItemID)
		if _, dup := want[key]; dup {
			continue
		}
		if len(order) >= chkMaxTargets {
			dropped++
			continue
		}
		want[key] = t
		order = append(order, key)
	}
	if dropped > 0 {
		log.Printf("Device checks: %d target(s) ignored (unknown rule or above the %d-target limit)", dropped, chkMaxTargets)
	}

	allowSecrets := secretsTransportAllowed(lim)

	// Stop the workers that disappeared or changed; remember their state.
	type carried struct {
		sticky     int
		lastStatus string
		lastCode   string
		lastTrace  time.Time
	}
	carry := make(map[string]carried)
	for key, w := range m.workers {
		nt, ok := want[key]
		sameRule := ok && newRules[nt.RuleID] == w.rule
		if ok && sameRule && sameCheckTarget(w, nt, allowSecrets) {
			continue
		}
		w.cancel()
		delete(m.workers, key)
		if ok {
			w.mu.Lock()
			c := carried{lastStatus: w.lastStatus, lastCode: w.lastCode, lastTrace: w.lastTraceAt, sticky: -1}
			if sameRule {
				c.sticky = w.stickyVariant // variants unchanged: keep the last good one
			}
			w.mu.Unlock()
			carry[key] = c
		}
	}

	// Start the new / changed workers.
	for _, key := range order {
		if _, running := m.workers[key]; running {
			continue
		}
		t := want[key]
		w := &checkWorker{
			key:           key,
			rule:          newRules[t.RuleID],
			runNow:        make(chan struct{}, 1),
			stickyVariant: -1,
		}
		w.wire, w.target = prepareCheckTarget(t, allowSecrets)
		if c, ok := carry[key]; ok {
			w.stickyVariant, w.lastStatus, w.lastCode, w.lastTraceAt = c.sticky, c.lastStatus, c.lastCode, c.lastTrace
		}
		wctx, cancel := context.WithCancel(m.ctx)
		w.cancel = cancel
		m.workers[key] = w
		go m.runWorker(wctx, w)
	}

	m.rules = newRules
	m.rev = cfg.Rev
	if m.rev == "" {
		m.rev = "unversioned"
	}
	m.pruneHostLocksLocked()
	log.Printf("Device checks: assignment applied (%d rule(s), %d target(s), concurrency %d)", len(newRules), len(m.workers), lim.maxConcurrency)
}

func (m *CheckManager) stopAllLocked() {
	for key, w := range m.workers {
		w.cancel()
		delete(m.workers, key)
	}
}

// pruneHostLocksLocked forgets the per-device locks of IPs no longer targeted
// (only when they are free).
func (m *CheckManager) pruneHostLocksLocked() {
	active := make(map[string]bool, len(m.workers))
	for _, w := range m.workers {
		active[w.target.ip] = true
	}
	m.hosts.Range(func(k, v any) bool {
		ip := k.(string)
		if active[ip] {
			return true
		}
		mu := v.(*sync.Mutex)
		if mu.TryLock() {
			m.hosts.Delete(ip)
			mu.Unlock()
		}
		return true
	})
}

func checkKey(ruleID, itemID int) string {
	return strconv.Itoa(ruleID) + ":" + strconv.Itoa(itemID)
}

// ruleFingerprint hashes a wire rule (rules never carry secrets).
func ruleFingerprint(r CheckRule) uint64 {
	b, _ := json.Marshal(r)
	h := fnv.New64a()
	h.Write(b)
	return h.Sum64()
}

func fnv32(s string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(s))
	return h.Sum32()
}

// prepareCheckTarget normalizes a wire target. Credentials are dropped (the
// strings are no longer referenced) when the probe does not reach its server
// over https and the local policy does not allow plaintext secrets.
func prepareCheckTarget(t CheckTarget, allowSecrets bool) (CheckTarget, runTarget) {
	rt := runTarget{
		ruleID:      t.RuleID,
		itemID:      t.ItemID,
		ip:          t.IP,
		creds:       t.Credentials,
		authBlocked: t.AuthBlocked,
	}
	if t.Mac != nil && strings.TrimSpace(*t.Mac) != "" {
		rt.mac = normalizeARPMac(*t.Mac)
		rt.macInvalid = rt.mac == ""
	}
	if t.Credentials != nil && !allowSecrets {
		t.Credentials = nil
		rt.creds = nil
		rt.credsBlocked = true
	}
	return t, rt
}

// sameCheckTarget reports whether a running worker already serves nt.
func sameCheckTarget(w *checkWorker, nt CheckTarget, allowSecrets bool) bool {
	cur := w.wire
	if cur.IP != nt.IP || cur.AuthBlocked != nt.AuthBlocked {
		return false
	}
	if (cur.Mac == nil) != (nt.Mac == nil) || (cur.Mac != nil && *cur.Mac != *nt.Mac) {
		return false
	}
	if w.target.credsBlocked {
		return nt.Credentials != nil && !allowSecrets
	}
	if (cur.Credentials == nil) != (nt.Credentials == nil) {
		return false
	}
	if cur.Credentials != nil &&
		(cur.Credentials.Username != nt.Credentials.Username || cur.Credentials.Password != nt.Credentials.Password) {
		return false
	}
	return true
}

// compileRule validates r against the limits and compiles its regexes and
// paths. It never fails: a rule that cannot run is returned with denyCode.
func compileRule(r CheckRule, lim checkLimits) *compiledRule {
	cr := &compiledRule{rule: r, fingerprint: ruleFingerprint(r), fields: r.Fields}

	cr.interval = time.Duration(r.Schedule.IntervalSeconds) * time.Second
	if cr.interval < lim.minInterval {
		cr.interval = lim.minInterval // local policy: max(server, local, 30 s)
	}
	if cr.interval > chkMaxInterval {
		cr.interval = chkMaxInterval
	}
	cr.jitter = time.Duration(r.Schedule.JitterSeconds) * time.Second
	if cr.jitter < 0 {
		cr.jitter = 0
	}
	if cr.jitter > chkMaxJitter {
		cr.jitter = chkMaxJitter
	}
	if cr.jitter > cr.interval/2 {
		cr.jitter = cr.interval / 2
	}
	cr.timeout = time.Duration(r.Schedule.TimeoutMs) * time.Millisecond
	if cr.timeout < chkMinTimeout || cr.timeout > chkMaxTimeout {
		cr.timeout = chkMaxTimeout
	}

	if err := validateRuleLimits(&r, lim); err != nil {
		cr.denyCode, cr.denyMsg = chkErrPolicyDenied, sanitizeErrMessage(err.Error())
		return cr
	}

	for _, v := range r.Variants {
		cv := compiledVariant{v: v, expect: make(map[int]bool)}
		for _, st := range v.Request.ExpectStatus {
			cv.expect[st] = true
		}
		if len(cv.expect) == 0 {
			cv.expect[http.StatusOK] = true
		}
		for _, e := range v.Extract {
			ce, err := compileExtractor(e)
			if err != nil {
				code := chkErrRegexCompile
				if e.Type != "regex" {
					code = chkErrPolicyDenied
				}
				cr.denyCode = code
				cr.denyMsg = sanitizeErrMessage(fmt.Sprintf("variant %s field %s: %v", v.ID, e.Field, err))
				return cr
			}
			cv.extractors = append(cv.extractors, ce)
		}
		cr.variants = append(cr.variants, cv)
	}
	for _, t := range r.RegexTests {
		re, err := regexp.Compile(t.Pattern)
		if err != nil {
			cr.denyCode = chkErrRegexCompile
			cr.denyMsg = sanitizeErrMessage(fmt.Sprintf("regex test %s: %v", truncate(t.ID, 32), err))
			return cr
		}
		cr.tests = append(cr.tests, compiledTest{id: t.ID, field: t.Field, re: re})
	}
	return cr
}

// ─── Workers ─────────────────────────────────────────────────────────────────

// runWorker schedules one rule:item target: a deterministic first offset in
// [0, interval) spreads the targets, then interval ± jitter.
func (m *CheckManager) runWorker(ctx context.Context, w *checkWorker) {
	interval := w.rule.interval
	secs := uint32(interval / time.Second)
	if secs == 0 {
		secs = 1
	}
	first := time.Duration(fnv32(w.key)%secs) * time.Second
	t := time.NewTimer(first)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.runNow:
			m.runOnce(ctx, w, true)
		case <-t.C:
			m.runOnce(ctx, w, false)
			t.Reset(nextCheckDelay(interval, w.rule.jitter))
		}
	}
}

// nextCheckDelay returns interval plus a random jitter in [-j, +j].
func nextCheckDelay(interval, j time.Duration) time.Duration {
	if j <= 0 {
		return interval
	}
	d := interval + time.Duration(rand.Int63n(int64(2*j)+1)) - j
	if d < time.Second {
		d = time.Second
	}
	return d
}

// RunNow wakes the worker of ruleID:itemID. Ignored when there is none.
func (m *CheckManager) RunNow(ruleID, itemID int) bool {
	m.mu.Lock()
	w := m.workers[checkKey(ruleID, itemID)]
	m.mu.Unlock()
	if w == nil {
		return false
	}
	select {
	case w.runNow <- struct{}{}:
	default: // a run-now is already pending
	}
	return true
}

// runOnce executes one scheduled run and hands the result to the reporter.
func (m *CheckManager) runOnce(ctx context.Context, w *checkWorker, forceTrace bool) {
	w.mu.Lock()
	sticky := w.stickyVariant
	w.mu.Unlock()

	res, winner := m.execute(ctx, w.rule, &w.target, execOpts{
		sticky: sticky,
		budget: w.rule.interval / 2,
	})
	if ctx.Err() != nil {
		return // the target was removed while running
	}

	code := ""
	if res.Error != nil {
		code = res.Error.Code
	}
	now := time.Now()
	w.mu.Lock()
	if winner >= 0 {
		w.stickyVariant = winner
	}
	changed := res.Status != w.lastStatus || code != w.lastCode
	urgent := w.lastStatus != "" && res.Status != w.lastStatus
	keepTrace := forceTrace || changed || res.Status != "ok" || now.Sub(w.lastTraceAt) >= checkTraceSampleEvery
	if keepTrace {
		w.lastTraceAt = now
	} else {
		res.Trace = nil
	}
	w.lastStatus, w.lastCode = res.Status, code
	w.mu.Unlock()

	select {
	case m.out <- checkReport{res: res, urgent: urgent}:
	case <-ctx.Done():
	}
}

// ─── Test ────────────────────────────────────────────────────────────────────

var checkTestIDRe = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)

// Test runs rule once against target, outside the scheduler but under the
// same concurrency limit, host lock, target binding and limits, with the
// trace on and a redacted body snippet. The rule is compiled for this run
// only: it may be an unsaved draft, sent without an id (an id ≤ 0 is a draft
// and the result carries ruleId 0). The whole test, waits included, ends
// within checkTestMaxDuration.
func (m *CheckManager) Test(rule CheckRule, target CheckTarget) CheckResult {
	if rule.ID < 0 {
		rule.ID = 0
	}
	target.RuleID = rule.ID
	select {
	case m.testSlots <- struct{}{}:
		defer func() { <-m.testSlots }()
	default:
		res := newCheckResult(rule.ID, rule.Rev, target.ItemID, target.IP, time.Now())
		res.Error = &CheckError{Code: chkErrOverrun, Message: "another device check test is running on this probe"}
		return res
	}

	m.mu.Lock()
	lim := m.lim
	m.mu.Unlock()
	cr := compileRule(rule, lim)
	_, rt := prepareCheckTarget(target, secretsTransportAllowed(lim))

	ctx, cancel := context.WithTimeout(m.ctx, checkTestMaxDuration)
	defer cancel()
	res, _ := m.execute(ctx, cr, &rt, execOpts{
		sticky:   -1,
		budget:   checkTestBudget,
		waitHost: true,
		snippet:  true,
	})
	return res
}

// ─── Execution ───────────────────────────────────────────────────────────────

type execOpts struct {
	sticky   int           // variant tried first (-1: declaration order)
	budget   time.Duration // max wait for the rate limiter and the semaphore
	waitHost bool          // wait (within budget) for the device instead of reporting overrun
	snippet  bool          // attach a redacted body snippet (tests)
}

func newCheckResult(ruleID, ruleRev, itemID int, ip string, start time.Time) CheckResult {
	return CheckResult{
		RuleID:    ruleID,
		RuleRev:   ruleRev,
		ItemID:    itemID,
		IP:        ip,
		StartedAt: start.UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		Status:    "error",
		MacCheck:  "unverified",
		Values:    map[string]any{},
		Regex:     map[string]*bool{},
	}
}

// traceBuf collects the trace steps of one run.
type traceBuf struct{ steps []TraceStep }

func (t *traceBuf) add(step, status string, d time.Duration, detail string) {
	if len(t.steps) >= checkMaxTraceSteps {
		return
	}
	t.steps = append(t.steps, TraceStep{
		Step:   capString(step, 64),
		Status: status,
		Ms:     d.Milliseconds(),
		Detail: sanitizeErrMessage(detail),
	})
}

// hostLock returns the per-device lock of ip.
func (m *CheckManager) hostLock(ip string) *sync.Mutex {
	v, _ := m.hosts.LoadOrStore(ip, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// execute runs cr against t once and returns the result and the index of the
// winning variant (-1 when none succeeded). The trace is always filled; the
// caller decides whether to keep it.
func (m *CheckManager) execute(ctx context.Context, cr *compiledRule, t *runTarget, o execOpts) (CheckResult, int) {
	start := time.Now()
	res := newCheckResult(t.ruleID, cr.rule.Rev, t.itemID, t.ip, start)
	tr := &traceBuf{}
	finish := func(code, msg string) (CheckResult, int) {
		res.Status = "error"
		res.Error = &CheckError{Code: code, Message: sanitizeErrMessage(msg)}
		res.Values = map[string]any{}
		res.Regex = map[string]*bool{}
		res.DurationMs = time.Since(start).Milliseconds()
		res.Trace = tr.steps
		return res, -1
	}

	// 0. Rules refused by the limits / the local policy, or that do not compile.
	if cr.denyCode != "" {
		tr.add("policy", "failed", 0, cr.denyMsg)
		return finish(cr.denyCode, cr.denyMsg)
	}

	// 1. One in-flight run per device.
	deadline := start.Add(o.budget)
	hostMu := m.hostLock(t.ip)
	if !lockHost(ctx, hostMu, o.waitHost, deadline) {
		tr.add("schedule", "failed", time.Since(start), "a previous check of this device is still running")
		return finish(chkErrOverrun, "a previous check of this device is still running")
	}
	defer hostMu.Unlock()

	// 2. Probe-wide rate limit.
	if !m.bucket.wait(ctx, deadline) {
		tr.add("schedule", "failed", time.Since(start), "probe-wide check rate limit reached")
		return finish(chkErrOverrun, fmt.Sprintf("probe-wide check rate limit reached (%d runs per minute)", chkMaxRunsPerMinute))
	}

	// 3. Concurrency limit.
	m.mu.Lock()
	sem := m.sem
	m.mu.Unlock()
	if !acquireSem(ctx, sem, deadline) {
		tr.add("schedule", "failed", time.Since(start), "concurrency limit reached")
		return finish(chkErrOverrun, "probe check concurrency limit reached")
	}
	defer func() { <-sem }()

	// 4. Target binding: private LAN host inside the scanned subnets.
	stepStart := time.Now()
	if err := checkTargetGuard(t.ip); err != nil {
		tr.add("target", "failed", time.Since(stepStart), err.Error())
		return finish(chkErrTargetNotAllowed, err.Error())
	}
	if t.macInvalid {
		tr.add("target", "failed", 0, "invalid MAC address in the assignment")
		return finish(chkErrTargetNotAllowed, "invalid MAC address in the assignment")
	}
	if cr.rule.RequireMac && t.mac == "" {
		tr.add("target", "failed", 0, "the rule requires a MAC address and the device has none")
		return finish(chkErrTargetNotAllowed, "the rule requires a MAC address and the device has none")
	}
	tr.add("target", "ok", time.Since(stepStart), t.ip)

	// MAC before dialing: the cached ARP table must not show another device.
	if t.mac != "" {
		stepStart = time.Now()
		if cached, ok := arpCache.get(ctx, t.ip); ok && cached != t.mac {
			// The cache may be up to 30 s old: a fresh lookup can clear the
			// device, but only by showing its MAC. Without a fresh entry the
			// last known state (another device) stands: no connection.
			arpCache.invalidate()
			fresh, ok := arpLookupFreshFn(t.ip)
			if !ok {
				tr.add("mac", "failed", time.Since(stepStart), "ARP showed another MAC address for "+t.ip+", not cleared by a fresh lookup")
				return finish(chkErrMacMismatch, "the ARP table showed another MAC address for "+t.ip+" and a fresh lookup did not confirm this device; no request sent")
			}
			if fresh != t.mac {
				tr.add("mac", "failed", time.Since(stepStart), "ARP shows another MAC address for "+t.ip)
				return finish(chkErrMacMismatch, "the ARP table shows another MAC address for "+t.ip+"; no request sent")
			}
		}
		tr.add("mac", "ok", time.Since(stepStart), "no conflicting ARP entry; verified again after connect")
	} else {
		tr.add("mac", "skipped", 0, "no MAC bound to this target")
	}

	// 5. Credentials.
	if t.authBlocked != "" {
		tr.add("auth", "failed", 0, "credentials unavailable ("+t.authBlocked+")")
		return finish(chkErrCredsUnavailable, "credentials unavailable ("+t.authBlocked+")")
	}
	if t.credsBlocked {
		tr.add("auth", "failed", 0, "credentials refused: the probe does not reach its server over https")
		return finish(chkErrInsecureTransp, "credentials refused: the probe does not reach its server over https")
	}

	// 6. Variants, the last successful one first.
	var (
		lastErr   *checkErr
		lastOut   *httpOutcome
		winner    = -1
		rawValues map[string]*string
	)
	for _, idx := range variantOrder(len(cr.variants), o.sticky) {
		cv := &cr.variants[idx]
		q := &cv.v.Request
		stepName := "variant:" + cv.v.ID
		if ctx.Err() != nil {
			// A test out of time (a scheduled run is only cancelled when its
			// target is removed, and that result is dropped).
			lastErr = newCheckErr(chkErrTimeout, "time limit reached before variant "+cv.v.ID+" could be tried")
			tr.add(stepName, "skipped", 0, lastErr.msg)
			break
		}
		res.Attempts++

		var creds *CheckCredentials
		authNote := ""
		if q.Auth == "basic" {
			if t.creds == nil {
				lastErr = newCheckErr(chkErrCredsUnavailable, "variant "+cv.v.ID+" requires credentials")
				tr.add(stepName, "failed", 0, lastErr.msg)
				continue
			}
			if t.mac == "" {
				lastErr = newCheckErr(chkErrMacUnverified, "credentials require a MAC-bound target")
				tr.add(stepName, "failed", 0, lastErr.msg)
				break
			}
			creds = t.creds
			authNote = ", auth=basic(***)"
		}

		stepStart = time.Now()
		actx, cancel := context.WithTimeout(ctx, cr.timeout)
		out, cerr := doCheckHTTP(actx, &checkHTTPRequest{ip: t.ip, mac: t.mac, req: q, timeout: cr.timeout, creds: creds})
		cancel()
		reqDesc := fmt.Sprintf("%s %s://%s:%d%s%s", methodOrGet(q.Method), q.Scheme, t.ip, q.Port, q.Path, authNote)
		if cerr != nil {
			lastErr = cerr
			tr.add(stepName, "failed", time.Since(stepStart), reqDesc+": "+cerr.code+" "+cerr.msg)
			if fatalCheckError(cerr.code) {
				break
			}
			continue
		}
		lastOut = out
		res.HTTPStatus, res.Bytes, res.Truncated = out.status, out.bytes, out.truncated
		desc := fmt.Sprintf("%s → HTTP %d, %d B (%s)", reqDesc, out.status, out.bytes, out.charset)
		if out.truncated {
			desc += ", truncated"
		}
		if !cv.expect[out.status] {
			lastErr = newCheckErr(chkErrHTTPStatus, fmt.Sprintf("HTTP %d (expected %s)", out.status, expectList(q.ExpectStatus)))
			tr.add(stepName, "failed", out.duration, desc)
			continue
		}
		tr.add(stepName, "ok", out.duration, desc)

		in := &extractInput{body: out.body, header: out.header, status: out.status, durationMs: out.duration.Milliseconds()}
		vals, missing := runExtractors(cv, in)
		if len(missing) > 0 {
			lastErr = newCheckErr(chkErrExtractFailed, "required field(s) not found: "+strings.Join(missing, ", "))
			tr.add("extract:"+cv.v.ID, "failed", 0, lastErr.msg)
			continue
		}
		tr.add("extract:"+cv.v.ID, "ok", 0, fmt.Sprintf("%d of %d field(s) found", len(vals), len(cr.fields)))
		winner = idx
		rawValues = vals
		if out.macVerified {
			res.MacCheck = "match"
		}
		break
	}

	if o.snippet && lastOut != nil && lastOut.body != "" && snippetContentType(lastOut.contentType, lastOut.body) {
		res.BodySnippet = redactSnippet(lastOut.body)
	}

	if winner < 0 {
		if lastErr == nil {
			lastErr = newCheckErr(chkErrInternal, "no variant could be attempted")
		}
		return finish(lastErr.code, lastErr.msg)
	}

	// 7. Values coerced to the declared types; regex tests on coerced values.
	vid := cr.variants[winner].v.ID
	res.VariantID = &vid
	res.Status = "ok"
	for i := range cr.fields {
		f := &cr.fields[i]
		res.Values[f.Key] = coerceValue(f, rawValues[f.Key])
	}
	for _, test := range cr.tests {
		subject, ok := regexTestSubject(res.Values[test.field])
		if !ok {
			res.Regex[test.id] = nil
			continue
		}
		matched := test.re.MatchString(subject)
		res.Regex[test.id] = &matched
	}
	res.DurationMs = time.Since(start).Milliseconds()
	res.Trace = tr.steps
	return res, winner
}

// runExtractors runs the extractors of a variant. For each field the first
// extractor that finds its element wins; missing lists the fields of required
// extractors whose element was not found (a found element with an empty
// value counts as found).
func runExtractors(cv *compiledVariant, in *extractInput) (map[string]*string, []string) {
	vals := make(map[string]*string)
	found := make(map[string]bool)
	for i := range cv.extractors {
		ce := &cv.extractors[i]
		field := ce.ex.Field
		if found[field] {
			continue
		}
		raw, ok := ce.run(in)
		if !ok {
			continue
		}
		found[field] = true
		vals[field] = applyTransforms(raw, ce.ex.Transforms)
	}
	var missing []string
	seen := make(map[string]bool)
	for i := range cv.extractors {
		ex := &cv.extractors[i].ex
		if ex.Required && !found[ex.Field] && !seen[ex.Field] {
			seen[ex.Field] = true
			missing = append(missing, ex.Field)
		}
	}
	sort.Strings(missing)
	return vals, missing
}

// variantOrder returns the variant indexes, the sticky one first.
func variantOrder(n, sticky int) []int {
	order := make([]int, 0, n)
	if sticky >= 0 && sticky < n {
		order = append(order, sticky)
	}
	for i := 0; i < n; i++ {
		if i != sticky {
			order = append(order, i)
		}
	}
	return order
}

// fatalCheckError: errors that no other variant can fix (the target itself
// is refused), so the remaining variants are not tried.
func fatalCheckError(code string) bool {
	switch code {
	case chkErrMacMismatch, chkErrMacUnverified, chkErrTargetNotAllowed, chkErrPolicyDenied:
		return true
	}
	return false
}

func methodOrGet(m string) string {
	if m == "" {
		return http.MethodGet
	}
	return m
}

func expectList(st []int) string {
	if len(st) == 0 {
		return "200"
	}
	parts := make([]string, len(st))
	for i, s := range st {
		parts[i] = strconv.Itoa(s)
	}
	return strings.Join(parts, "/")
}

// acquireSem takes a slot of sem, waiting until deadline at most.
func acquireSem(ctx context.Context, sem chan struct{}, deadline time.Time) bool {
	select {
	case sem <- struct{}{}:
		return true
	default:
	}
	wait := time.Until(deadline)
	if wait <= 0 {
		return false
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case sem <- struct{}{}:
		return true
	case <-t.C:
		return false
	case <-ctx.Done():
		return false
	}
}

// lockHost takes the device lock: TryLock for scheduled runs (busy → overrun),
// or polled until deadline for tests.
func lockHost(ctx context.Context, mu *sync.Mutex, wait bool, deadline time.Time) bool {
	if mu.TryLock() {
		return true
	}
	if !wait {
		return false
	}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return false
		case <-tick.C:
			if mu.TryLock() {
				return true
			}
		}
	}
	return false
}

// ─── Body snippet (tests only) ───────────────────────────────────────────────

var snippetSecretRe = regexp.MustCompile(`(?i)(pass|pwd|secret|token|key|auth)`)

// redactSnippet returns the first 4 KiB of body, with every line that looks
// like it may hold a secret replaced by "[redacted]". Each line is examined
// whole (even when it extends past the 4 KiB cut) before it is cut.
func redactSnippet(body string) string {
	var b strings.Builder
	rest := body
	for rest != "" && b.Len() < checkSnippetBytes {
		line := rest
		if i := strings.IndexByte(rest, '\n'); i >= 0 {
			line, rest = rest[:i], rest[i+1:]
		} else {
			rest = ""
		}
		line = strings.TrimSuffix(line, "\r")
		if snippetSecretRe.MatchString(line) {
			line = "[redacted]"
		} else {
			line = stripSnippetControls(line)
		}
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(line)
	}
	return capString(b.String(), checkSnippetBytes)
}

// stripSnippetControls removes control characters except tabs.
func stripSnippetControls(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\t' {
			return r
		}
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return -1
		}
		return r
	}, s)
}

// ─── Token bucket ────────────────────────────────────────────────────────────

// tokenBucket limits the probe-wide run rate (perMinute runs per minute,
// bursts up to perMinute).
type tokenBucket struct {
	mu     sync.Mutex
	tokens float64
	max    float64
	perSec float64
	last   time.Time
}

func newTokenBucket(perMinute int) *tokenBucket {
	return &tokenBucket{
		tokens: float64(perMinute),
		max:    float64(perMinute),
		perSec: float64(perMinute) / 60,
		last:   time.Now(),
	}
}

// take takes one token, or returns how long until one is available.
func (b *tokenBucket) take() (bool, time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	b.tokens += now.Sub(b.last).Seconds() * b.perSec
	if b.tokens > b.max {
		b.tokens = b.max
	}
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	return false, time.Duration((1 - b.tokens) / b.perSec * float64(time.Second))
}

// wait takes a token, waiting until deadline at most.
func (b *tokenBucket) wait(ctx context.Context, deadline time.Time) bool {
	for {
		ok, d := b.take()
		if ok {
			return true
		}
		if time.Now().Add(d).After(deadline) {
			return false
		}
		t := time.NewTimer(d)
		select {
		case <-ctx.Done():
			t.Stop()
			return false
		case <-t.C:
		}
	}
}
