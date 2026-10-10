package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"sync/atomic"
	"time"
)

// ─── Device Checks: result reporting ─────────────────────────────────────────
//
// WS mode: batches of at most 50 results, sent every 5 s, or at once when a
// target's status (ok / error) changes, through the control WebSocket
// ({type:"check_results", v:1, sentAt, results}). The server accepts at most
// one batch per second per probe, so batches are spaced by more than 1 s.
//
// No WebSocket (HTTP polling mode, or WS reconnecting): results wait in a
// ring of 500 (when full, only the latest result per target is kept). In HTTP
// polling mode the ring is flushed every 30 s through POST
// /api/probe/check-results, only while checks are configured. A 401 / 404
// (server without the endpoint, or refusing it) pauses the HTTP flush for one
// hour WITHOUT touching cfg.BackoffUntil (the push backoff); a 409 (probe not
// approved / no site) drops the batch.

// httpPollingMode is set by mainLoop when the probe runs in HTTP polling mode
// (the server offers no WebSocket).
var httpPollingMode atomic.Bool

// checkRep is the probe-wide reporter (nil until mainLoop creates it).
var checkRep *checkReporter

const (
	checkWSBatch                = 50
	checkWSFlushEvery           = 5 * time.Second
	checkWSMinGap               = 1100 * time.Millisecond
	checkHTTPFlushEvery         = 30 * time.Second
	checkHTTPUnsupportedFor     = time.Hour
	checkHTTPMaxBatchesPerFlush = 3
)

// checkReporter drains the manager's results. Only its run goroutine touches
// its fields.
type checkReporter struct {
	mgr *CheckManager

	pending              []CheckResult // oldest first, at most chkRingSize
	urgent               bool
	lastWSSend           time.Time
	lastHTTPFlush        time.Time
	httpUnsupportedUntil time.Time
	httpPaused           bool // logged once per pause
}

func newCheckReporter(m *CheckManager) *checkReporter {
	return &checkReporter{mgr: m, lastHTTPFlush: time.Now()}
}

// run is the reporter loop (one goroutine for the life of the probe).
func (r *checkReporter) run(ctx context.Context) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case rep := <-r.mgr.out:
			r.add(rep)
			r.flushWS()
		case <-tick.C:
			r.flushWS()
			r.flushHTTP()
		}
	}
}

// add queues a result, compacting the ring when it is full.
func (r *checkReporter) add(rep checkReport) {
	if len(r.pending) >= chkRingSize {
		r.pending = compactCheckResults(r.pending, chkRingSize-1)
	}
	r.pending = append(r.pending, rep.res)
	if rep.urgent {
		r.urgent = true
	}
}

// compactCheckResults keeps only the latest result of each rule:item target
// (in their original order), then at most max of them (the newest).
func compactCheckResults(results []CheckResult, max int) []CheckResult {
	seen := make(map[string]bool, len(results))
	kept := make([]CheckResult, 0, len(results))
	for i := len(results) - 1; i >= 0; i-- {
		key := checkKey(results[i].RuleID, results[i].ItemID)
		if seen[key] {
			continue
		}
		seen[key] = true
		kept = append(kept, results[i])
	}
	for i, j := 0, len(kept)-1; i < j; i, j = i+1, j-1 {
		kept[i], kept[j] = kept[j], kept[i]
	}
	if len(kept) > max {
		kept = kept[len(kept)-max:]
	}
	return kept
}

func checkSentAt() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// flushWS sends one batch on the control WebSocket when one is connected and
// a batch is due (status change, 50 results waiting, or 5 s since the last).
func (r *checkReporter) flushWS() {
	if len(r.pending) == 0 || !wsConnected() {
		return
	}
	since := time.Since(r.lastWSSend)
	if since < checkWSMinGap {
		return
	}
	if !r.urgent && len(r.pending) < checkWSBatch && since < checkWSFlushEvery {
		return
	}
	n := len(r.pending)
	if n > checkWSBatch {
		n = checkWSBatch
	}
	msg := map[string]interface{}{
		"type":    "check_results",
		"v":       1,
		"sentAt":  checkSentAt(),
		"results": r.pending[:n],
	}
	if err := wsSendCurrent(msg); err != nil {
		// Kept in the ring: sent after the reconnect.
		return
	}
	r.lastWSSend = time.Now()
	r.pending = append([]CheckResult(nil), r.pending[n:]...)
	if len(r.pending) == 0 {
		r.urgent = false
	}
}

// flushHTTP posts the ring every 30 s in HTTP polling mode.
func (r *checkReporter) flushHTTP() {
	if !httpPollingMode.Load() || wsConnected() {
		return
	}
	if time.Since(r.lastHTTPFlush) < checkHTTPFlushEvery {
		return
	}
	r.lastHTTPFlush = time.Now()
	if !r.mgr.configured() {
		r.pending = nil // nothing configured any more: these results would be rejected
		return
	}
	if len(r.pending) == 0 {
		return
	}
	if time.Now().Before(r.httpUnsupportedUntil) {
		return
	}
	if r.httpPaused {
		r.httpPaused = false
		log.Printf("Device checks: retrying the HTTP result upload")
	}

	for i := 0; i < checkHTTPMaxBatchesPerFlush && len(r.pending) > 0; i++ {
		n := len(r.pending)
		if n > chkMaxBatch {
			n = chkMaxBatch
		}
		status, err := postCheckResults(r.pending[:n])
		if err != nil {
			log.Printf("WARN: device check results upload failed: %v", err)
			return
		}
		switch {
		case status >= 200 && status < 300:
			r.pending = append([]CheckResult(nil), r.pending[n:]...)
		case status == http.StatusUnauthorized || status == http.StatusNotFound:
			// Old server (no endpoint: 401 from requireAuth) or not accepted:
			// pause this upload only; the push backoff is left alone.
			r.httpUnsupportedUntil = time.Now().Add(checkHTTPUnsupportedFor)
			r.httpPaused = true
			log.Printf("WARN: device check results refused (HTTP %d) — pausing the HTTP upload for %v", status, checkHTTPUnsupportedFor)
			return
		case status == http.StatusConflict || status == http.StatusForbidden ||
			status == http.StatusBadRequest || status == http.StatusRequestEntityTooLarge ||
			status == http.StatusUnprocessableEntity:
			// Not approved / no site / refused / malformed: never accepted as is.
			log.Printf("WARN: device check results rejected (HTTP %d) — dropping %d result(s)", status, n)
			r.pending = append([]CheckResult(nil), r.pending[n:]...)
		default:
			// 429 / 5xx: keep the ring, retry at the next flush.
			log.Printf("WARN: device check results upload: HTTP %d — retrying later", status)
			return
		}
	}
}

// postCheckResults sends one batch to POST /api/probe/check-results with the
// probe authentication headers (API key, UUID, identity token). The feature
// advertisement is left off: this endpoint never issues an identity token.
func postCheckResults(results []CheckResult) (int, error) {
	payload, err := json.Marshal(ResultsBatch{V: 1, SentAt: checkSentAt(), Results: results})
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequest(http.MethodPost, cfg.ServerURL+"/api/probe/check-results", bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	setProbeAuthHeaders(req.Header, false)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode, nil
}
