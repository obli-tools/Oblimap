//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Update / uninstall helpers run msiexec from a detached batch script (the
// script outlives the service process). Every file lives in a fresh, randomly
// named directory under %ProgramData%\OblimapProbe (SYSTEM + Administrators
// only, see ensureConfigPerms) — never under %TEMP% with a predictable name —
// and is created with O_EXCL. No secret is ever written to these scripts:
// msiexec keeps using the probe's existing config.json.

// batchSafe reports whether s can be embedded inside a double-quoted batch
// argument without being altered or breaking out ("%" expands, "!" with
// delayed expansion, quotes and control characters end the argument).
func batchSafe(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
		switch r {
		case '"', '%', '!', '^', '&', '|', '<', '>':
			return false
		}
	}
	return true
}

// launchDetachedBatch writes script into workDir and starts it detached.
func launchDetachedBatch(workDir, name, script string) error {
	batchPath := filepath.Join(workDir, name)
	if err := writeFileExclusive(batchPath, []byte(script), 0700); err != nil {
		return fmt.Errorf("write batch: %w", err)
	}
	cmd := exec.Command("cmd.exe", "/c", "start", "", "/b", batchPath)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start batch: %w", err)
	}
	_ = cmd.Process.Release()
	return nil
}

// batchCleanup returns the batch lines that leave workDir and delete it
// (including the running script itself) once msiexec has finished.
func batchCleanup(workDir string) string {
	return fmt.Sprintf("cd /d \"%%SystemRoot%%\"\r\nrmdir /s /q \"%s\"\r\n", workDir)
}

func performUninstall(serverURL string) {
	workDir, err := makePrivateWorkDir("uninstall-")
	if err != nil {
		log.Printf("ERROR: create uninstall work dir: %v", err)
		return
	}
	if !batchSafe(workDir) {
		log.Printf("ERROR: uninstall work dir path cannot be used in a batch script")
		os.RemoveAll(workDir)
		return
	}

	// Download the MSI and use msiexec /x to uninstall cleanly
	msiURL := fmt.Sprintf("%s/api/probe/download/oblimap-probe.msi", serverURL)
	msiPath := filepath.Join(workDir, "oblimap-probe-uninstall.msi")

	if err := downloadFile(msiURL, msiPath, 0600); err != nil {
		log.Printf("WARN: could not download MSI for uninstall (%v) — falling back to sc delete", err)
		// Fallback: stop + delete service directly
		script := strings.ReplaceAll(fmt.Sprintf(`@echo off
ping 127.0.0.1 -n 3 > nul
sc stop %s 2>nul
sc delete %s 2>nul
rmdir /s /q "%%ProgramFiles%%\OblimapProbe" 2>nul
`, serviceName, serviceName), "\n", "\r\n") + batchCleanup(workDir)
		if err2 := launchDetachedBatch(workDir, "uninstall.bat", script); err2 != nil {
			log.Printf("ERROR: uninstall batch: %v", err2)
			os.RemoveAll(workDir)
			return
		}
		time.Sleep(500 * time.Millisecond)
		return
	}

	// MSI uninstall via detached batch script (process must exit first)
	script := strings.ReplaceAll(fmt.Sprintf(`@echo off
ping 127.0.0.1 -n 3 > nul
msiexec /x "%s" /quiet /norestart
`, msiPath), "\n", "\r\n") + batchCleanup(workDir)

	if err := launchDetachedBatch(workDir, "uninstall.bat", script); err != nil {
		log.Printf("ERROR: uninstall batch: %v", err)
		os.RemoveAll(workDir)
		return
	}
	time.Sleep(500 * time.Millisecond)
}

func applyUpdate(latestVersion string) {
	if !updateMu.TryLock() {
		log.Printf("Auto-update: an update is already in progress — skipping")
		return
	}
	defer updateMu.Unlock()
	if !updateAttemptAllowed(latestVersion) {
		return
	}

	workDir, err := makePrivateWorkDir("update-")
	if err != nil {
		log.Printf("Auto-update: cannot create work dir: %v", err)
		reportUpdateAborted(latestVersion, "install_failed")
		return
	}
	if !batchSafe(workDir) {
		log.Printf("Auto-update: work dir path cannot be used in a batch script — aborting")
		os.RemoveAll(workDir)
		reportUpdateAborted(latestVersion, "install_failed")
		return
	}

	// Download new MSI (verified against X-Content-SHA256 when provided).
	// No --version check here: the MSI is not an executable we can query.
	msiURL := fmt.Sprintf("%s/api/probe/download/oblimap-probe.msi", cfg.ServerURL)
	msiPath := filepath.Join(workDir, "oblimap-probe-update.msi")

	log.Printf("Auto-update: downloading MSI → v%s", latestVersion)
	if err := downloadFile(msiURL, msiPath, 0600); err != nil {
		log.Printf("Auto-update: MSI download failed: %v", err)
		os.RemoveAll(workDir)
		updateAborted(latestVersion, downloadFailureReason(err))
		return
	}

	// The API key is never passed on the msiexec command line (it would land
	// in this script, the service ImagePath and HKLM): the probe keeps reading
	// it from its existing config.json. SERVERURL is not secret and keeps the
	// MSI's registry value and service arguments populated as before.
	props := ""
	if batchSafe(cfg.ServerURL) {
		props = fmt.Sprintf(` SERVERURL="%s"`, cfg.ServerURL)
	} else {
		log.Printf("WARN: Auto-update: server URL contains characters unsafe for a batch script — not passing SERVERURL (the probe keeps its config)")
	}

	// Launch msiexec via a detached batch script — the script outlives the
	// service process. msiexec stops the service, installs the new version,
	// then restarts it.
	script := strings.ReplaceAll(fmt.Sprintf(`@echo off
ping 127.0.0.1 -n 3 > nul
msiexec /i "%s" /quiet /norestart%s
`, msiPath, props), "\n", "\r\n") + batchCleanup(workDir)

	notifyUpdating()

	if err := launchDetachedBatch(workDir, "update.bat", script); err != nil {
		log.Printf("ERROR: update batch: %v", err)
		os.RemoveAll(workDir)
		updateAborted(latestVersion, "install_failed")
		return
	}

	log.Printf("Auto-update: MSI update to v%s initiated — service will restart shortly...", latestVersion)
	os.Exit(0)
}
