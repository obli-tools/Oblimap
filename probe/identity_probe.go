package main

// Probe side of the Obli* device identity v2 (device_identity*.go are shared
// verbatim across the Obli* agents and must not be edited here).

import (
	"log"
	"sync"
	"time"
)

// setupDeviceIdentity sets the runtime device ID at startup: the shared
// Obli* device ID once the server acknowledged it (config identityV2), else
// the legacy resolver's result (resolveDeviceUUID, unchanged). Starts the
// shared-file watcher.
func setupDeviceIdentity() {
	cfgMu.Lock()
	storedV2, stored := cfg.IdentityV2, cfg.DeviceUUID
	cfgMu.Unlock()

	cur, shared := initDeviceIdentity(storedV2, stored,
		func() string { return resolveDeviceUUID(stored) },
		"oblimap-probe/"+ProbeVersion,
		func(newID string) {
			// Server acknowledged the shared ID: persist it, then redial the
			// control WebSocket under the new ID.
			if !saveConfigWith(func(c *Config) { c.DeviceUUID = newID; c.IdentityV2 = true }) {
				log.Printf("WARN: could not persist the shared device ID %s — the switch is replayed at the next start", newID)
			}
			reconnectControlWS()
		})

	if cur != stored || (shared && !storedV2) {
		saveConfigWith(func(c *Config) {
			c.DeviceUUID = cur
			if shared {
				c.IdentityV2 = true
			}
		})
	}

	go watchSharedIdentity(nil)
}

// identityPushRetry spaces the HTTP pushes the WebSocket mode makes for a
// pending switch when the server never answered them (HTTP unreachable while
// the WS works).
const identityPushRetry = 15 * time.Minute

var (
	identityPushMu        sync.Mutex
	identityPushAnswered  string    // target of the last push the server answered (200/202)
	identityPushAttemptAt time.Time // last HTTP push carrying a target
)

// pendingIdentityTarget returns the shared ID awaiting the server's ack ("" = none).
func pendingIdentityTarget() string {
	devIdentity.mu.RLock()
	defer devIdentity.mu.RUnlock()
	return devIdentity.target
}

func noteIdentityPushAttempt() {
	identityPushMu.Lock()
	identityPushAttemptAt = time.Now()
	identityPushMu.Unlock()
}

func noteIdentityPushAnswered(target string) {
	identityPushMu.Lock()
	identityPushAnswered = target
	identityPushMu.Unlock()
}

// identityHTTPPushDue tells the WebSocket scan worker to send this scan as an
// HTTP push instead: only the push re-keys the probe on the server (the WS
// scan_result never carries the identity headers). Once per pending target
// the server answered; a v1 server simply answers without an ack and the
// probe stays on its current ID over the WS.
func identityHTTPPushDue() bool {
	target := pendingIdentityTarget()
	if target == "" {
		return false
	}
	identityPushMu.Lock()
	defer identityPushMu.Unlock()
	if identityPushAnswered == target {
		return false
	}
	return identityPushAttemptAt.IsZero() || time.Since(identityPushAttemptAt) >= identityPushRetry
}

// identityHTTPPushAnswered reports whether the server answered an HTTP push
// carrying the given target.
func identityHTTPPushAnswered(target string) bool {
	identityPushMu.Lock()
	defer identityPushMu.Unlock()
	return target != "" && identityPushAnswered == target
}
