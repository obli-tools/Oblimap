//go:build !windows

package main

import (
	"log"
	"os"
	"syscall"
)

// restartWithNewBinary replaces the current process image with the binary at
// exePath using syscall.Exec (Unix exec — same PID, no fork).
//
// On systemd/launchd: os.Exit(0) would also work (service manager restarts).
// On systems without a service manager (rc.local, manual start): exec() in-place
// keeps the probe running without needing an external supervisor.
//
// Falls back to os.Exit(0) if exec fails so that service managers pick it up.
func restartWithNewBinary(exePath string) {
	log.Printf("Auto-update: re-executing new binary at %s", exePath)
	if err := syscall.Exec(exePath, os.Args, os.Environ()); err != nil {
		log.Printf("Auto-update: re-exec failed (%v) — exiting for service manager restart", err)
	}
	os.Exit(0)
}
