package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// maxDownloadBytes caps any update / installer download (the probe binary and
// MSI are ~10 MB) so a misbehaving server cannot fill the disk.
const maxDownloadBytes = 256 << 20

// updateMu serialises self-updates: every push response / config_update that
// advertises a newer version spawns applyUpdate, and two concurrent runs would
// race on the same files. A second caller returns immediately (TryLock).
var updateMu sync.Mutex

// errChecksumMismatch is returned when a download does not match the SHA-256
// advertised by the server in the X-Content-SHA256 response header.
var errChecksumMismatch = errors.New("checksum mismatch")

var sha256HexRe = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

// downloadFile fetches url with a 120-second timeout and writes the body to
// dest, which is created exclusively (O_EXCL: a stale file is removed first,
// a file planted concurrently makes the download fail) with mode perm.
// When the server provides X-Content-SHA256, the content is verified and dest
// is deleted on mismatch. Without the header the download is accepted (older
// servers) but a warning is logged.
func downloadFile(url, dest string, perm os.FileMode) error {
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	expected := strings.TrimSpace(resp.Header.Get("X-Content-SHA256"))
	if expected != "" && !sha256HexRe.MatchString(expected) {
		return fmt.Errorf("%w: malformed X-Content-SHA256 header", errChecksumMismatch)
	}

	if err := os.Remove(dest); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale %s: %w", filepath.Base(dest), err)
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	h := sha256.New()
	written, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, maxDownloadBytes+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && written > maxDownloadBytes {
		err = fmt.Errorf("download exceeds %d bytes", int64(maxDownloadBytes))
	}
	if err == nil && resp.ContentLength > 0 && written != resp.ContentLength {
		err = fmt.Errorf("download truncated (%d/%d bytes)", written, resp.ContentLength)
	}
	if err != nil {
		os.Remove(dest)
		return err
	}

	if expected == "" {
		log.Printf("WARN: server did not provide checksum for %s — integrity not verified", filepath.Base(dest))
		return nil
	}
	actual := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		os.Remove(dest)
		return fmt.Errorf("%w for %s (expected %s, got %s)", errChecksumMismatch, filepath.Base(dest), strings.ToLower(expected), actual)
	}
	log.Printf("Download %s: SHA-256 verified", filepath.Base(dest))
	return nil
}

// binaryVersionRe extracts x.y.z from "--version" output or a version string.
var binaryVersionRe = regexp.MustCompile(`v?(\d+\.\d+\.\d+)`)

// normalizeVersion returns the x.y.z part of a version string ("v2.2.0",
// "Oblimap Probe v2.2.0 (linux/amd64)" → "2.2.0"), or s unchanged when it
// contains none.
func normalizeVersion(s string) string {
	if m := binaryVersionRe.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return s
}

// updateVersionRefusal decides whether a downloaded binary reporting
// newVersion may replace the running version (Unix: the Windows MSI cannot be
// queried). latestVersion is the version the server advertised, "" for an
// explicit admin "update" command. It returns "" when the update may proceed,
// or an update_aborted reason code:
//   - same_version: nothing to update (both kinds of update);
//   - not_newer: an automatic update only ever moves forward, so a served
//     binary older than the running one (e.g. a pre-hardening build) is
//     refused even though the server advertised a newer version. An explicit
//     command installs whatever the server serves, which allows a rollback.
func updateVersionRefusal(newVersion, running, latestVersion string) string {
	if newVersion == running {
		return "same_version"
	}
	if latestVersion != "" && !isStrictlyNewer(newVersion, running) {
		return "not_newer"
	}
	return ""
}

// makePrivateWorkDir creates a fresh, randomly named directory (mode 0700)
// under the probe's config directory, which only root / SYSTEM +
// Administrators can write (see ensureConfigPerms) — never under /tmp or
// %TEMP%, where other local users could pre-create or swap files that are
// later run with elevated rights.
func makePrivateWorkDir(prefix string) (string, error) {
	base := configDir()
	if err := os.MkdirAll(base, 0700); err != nil {
		return "", err
	}
	return os.MkdirTemp(base, prefix)
}

// writeFileExclusive creates path (which must not exist) and writes data.
func writeFileExclusive(path string, data []byte, perm os.FileMode) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	return f.Close()
}

// ─── Update retry throttle ───────────────────────────────────────────────────

// updateRetryDelay: after a failed automatic update to a given version (bad
// checksum, broken binary, same version served…) the probe does not retry
// that version on every scan cycle, only after this delay.
const updateRetryDelay = 30 * time.Minute

var lastUpdateFailure struct {
	sync.Mutex
	version string
	at      time.Time
}

// updateAttemptAllowed reports whether an automatic update to version may be
// attempted now. Explicit "update" commands (version == "") always proceed.
func updateAttemptAllowed(version string) bool {
	if version == "" {
		return true
	}
	lastUpdateFailure.Lock()
	defer lastUpdateFailure.Unlock()
	if lastUpdateFailure.version == version && time.Since(lastUpdateFailure.at) < updateRetryDelay {
		return false
	}
	return true
}

// recordUpdateFailure remembers a failed update attempt (see updateAttemptAllowed).
func recordUpdateFailure(version string) {
	if version == "" {
		return
	}
	lastUpdateFailure.Lock()
	lastUpdateFailure.version = version
	lastUpdateFailure.at = time.Now()
	lastUpdateFailure.Unlock()
	log.Printf("Auto-update: will not retry v%s for %v", version, updateRetryDelay)
}
