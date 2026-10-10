//go:build !linux

package main

import (
	"context"
	"os/exec"
	"runtime"
	"time"
)

// readARPTable runs "arp -a" (Windows) / "arp -an" (macOS, BSD) and parses the output.
// Returns a map of ip → mac (uppercase, colon-separated, zero-padded).
//
// MACs are matched with or without zero-padding: macOS and the BSDs print
// "0:8:e1:1:2:3", which the former two-digit-only pattern missed entirely;
// every octet is left-padded (see parseARPOutput / normalizeARPMac in
// arp_cache.go). Broadcast and incomplete entries are skipped. The command is
// bounded (60 s) so a hung arp cannot block the scan or the checks forever.
//
// macOS and the BSDs run "arp -an": without -n, arp reverse-resolves every
// entry, which is slow and the scan reads the table up to three times per
// cycle. Windows keeps "arp -a" (-n / -N means something else there).
func readARPTable() map[string]string {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	args := []string{"-a"}
	if runtime.GOOS != "windows" {
		args = []string{"-an"}
	}
	out, err := exec.CommandContext(ctx, "arp", args...).Output()
	if err != nil && len(out) == 0 {
		return make(map[string]string)
	}
	return parseARPOutput(out)
}
