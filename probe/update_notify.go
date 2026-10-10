package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// notifyUpdating fires a best-effort POST to tell the server this probe is about to update.
// This lets the UI show "Updating…" badge and suppress false offline alerts.
func notifyUpdating() {
	body, _ := json.Marshal(map[string]string{
		"probeUuid": currentDeviceUUID(),
		"version":   ProbeVersion,
	})
	url := fmt.Sprintf("%s/api/probe/notifying-update", cfg.ServerURL)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	setProbeAuthHeaders(req.Header, true)

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("WARN: notify updating failed: %v", err)
		return
	}
	resp.Body.Close()
}

// updateAborted records a failed update attempt (retry throttle, automatic
// updates only) and reports it to the server.
func updateAborted(latestVersion, reason string) {
	recordUpdateFailure(latestVersion)
	reportUpdateAborted(latestVersion, reason)
}

// reportUpdateAborted tells the server, over the control WebSocket when one is
// open, that an update was not applied, so it can clear the "updating" state
// it set when it delivered an explicit update command (or when this probe sent
// notifying-update) and store the reason on the probe. Without an open control
// WebSocket (HTTP polling mode, or between two WS sessions) the report goes to
// POST /api/probe/agent/update-aborted (capability update_abort_http:1). Best
// effort: a server that does not know the message / route ignores it, and the
// next push reports the unchanged version anyway.
// reason is a short code: download_failed, checksum_mismatch,
// version_check_failed, same_version, not_newer, install_failed.
func reportUpdateAborted(latestVersion, reason string) {
	msg := map[string]string{
		"type":          "update_aborted",
		"reason":        reason,
		"version":       ProbeVersion,
		"targetVersion": latestVersion,
	}
	err := wsSendCurrent(msg)
	if err == nil {
		return
	}
	if !errors.Is(err, errWsNotConnected) {
		log.Printf("WARN: could not report the aborted update over the WebSocket: %v", err)
	}
	postUpdateAborted(latestVersion, reason)
}

// updateAbortedPath is the HTTP route of the update_aborted report.
const updateAbortedPath = "/api/probe/agent/update-aborted"

// updateAbortedBody is the JSON body of POST /api/probe/agent/update-aborted.
func updateAbortedBody(latestVersion, reason string) ([]byte, error) {
	return json.Marshal(map[string]string{
		"reason":        reason,
		"version":       ProbeVersion,
		"targetVersion": latestVersion,
	})
}

// postUpdateAborted sends the update_aborted report over HTTP, authenticated
// like the push (API key, UUID, identity token). Best effort, 10 s timeout.
func postUpdateAborted(latestVersion, reason string) {
	if cfg.ServerURL == "" {
		return
	}
	body, err := updateAbortedBody(latestVersion, reason)
	if err != nil {
		return
	}
	req, err := http.NewRequest(http.MethodPost, cfg.ServerURL+updateAbortedPath, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	setProbeAuthHeaders(req.Header, true)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("WARN: could not report the aborted update to the server: %v", err)
		return
	}
	resp.Body.Close()
	if updateAbortRouteMissing(resp.StatusCode) {
		// An older server without the route answers 404, or 401 (its /probe
		// router requires a user session first): logged once, not an error.
		updateAbortRouteMissingOnce.Do(func() {
			log.Printf("INFO: the server does not take aborted update reports over HTTP (HTTP %d); older server", resp.StatusCode)
		})
		return
	}
	if resp.StatusCode >= 400 {
		log.Printf("WARN: the server refused the aborted update report (HTTP %d)", resp.StatusCode)
	}
}

var updateAbortRouteMissingOnce sync.Once

// updateAbortRouteMissing: the answers of a server built before the HTTP
// update_aborted route (404, or 401 from its session-only /probe router).
func updateAbortRouteMissing(status int) bool {
	return status == http.StatusNotFound || status == http.StatusUnauthorized
}

// downloadFailureReason maps a downloadFile error to an update_aborted reason.
func downloadFailureReason(err error) string {
	if errors.Is(err, errChecksumMismatch) {
		return "checksum_mismatch"
	}
	return "download_failed"
}
