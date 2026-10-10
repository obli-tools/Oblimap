package main

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// ─── ARP lookups for device checks ───────────────────────────────────────────
//
// Device checks bind a target to its MAC address: before dialing, the cached
// ARP table (30 s TTL, since `arp -a` spawns a process on Windows and macOS)
// must not show another MAC for the IP; after the TCP connect, a fresh lookup
// of that single IP must confirm it before any byte is sent.

const (
	arpCacheTTL = 30 * time.Second
	// arpCacheWait bounds how long a check waits for a table refresh
	// (`arp -a` may take up to 60 s, see arp_other.go).
	arpCacheWait = 5 * time.Second
)

// readARPTableFn is readARPTable (arp_linux.go / arp_other.go); tests
// substitute it.
var readARPTableFn = readARPTable

// arpRefresh is one table read in progress; table is set before done closes.
type arpRefresh struct {
	done  chan struct{}
	table map[string]string
}

type arpCacheT struct {
	mu         sync.Mutex // never held while the table is read
	table      map[string]string
	at         time.Time
	gen        uint64      // bumped by invalidate: an older refresh is not cached
	refreshing *arpRefresh // the refresh of generation gen, nil when none runs
}

// arpCache is the probe-wide cached ARP table.
var arpCache = &arpCacheT{}

// get returns the cached MAC of ip (uppercase, colon-separated, zero-padded),
// refreshing the table when it is older than arpCacheTTL. When the refresh
// takes longer than arpCacheWait (or ctx ends first), the entry is reported
// absent: the fresh lookup after connect still verifies the device.
func (c *arpCacheT) get(ctx context.Context, ip string) (string, bool) {
	mac, ok := c.snapshot(ctx)[ip]
	if !ok {
		return "", false
	}
	mac = normalizeARPMac(mac)
	return mac, mac != ""
}

// snapshot returns the cached table, or starts a refresh when it is older
// than arpCacheTTL. One refresh runs at a time, in its own goroutine and
// outside c.mu, so a slow or hung `arp` never blocks the other checks (which
// hold a device lock and a concurrency slot while they wait here).
func (c *arpCacheT) snapshot(ctx context.Context) map[string]string {
	c.mu.Lock()
	if c.table != nil && time.Since(c.at) <= arpCacheTTL {
		table := c.table // never modified once cached
		c.mu.Unlock()
		return table
	}
	r := c.refreshing
	if r == nil {
		r = &arpRefresh{done: make(chan struct{})}
		c.refreshing = r
		go c.refresh(r, readARPTableFn, c.gen)
	}
	c.mu.Unlock()

	timer := time.NewTimer(arpCacheWait)
	defer timer.Stop()
	select {
	case <-r.done:
		return r.table
	case <-timer.C:
	case <-ctx.Done():
	}
	return nil
}

// refresh reads the table and caches it unless invalidate ran meanwhile.
func (c *arpCacheT) refresh(r *arpRefresh, read func() map[string]string, gen uint64) {
	table := read()
	if table == nil {
		table = make(map[string]string)
	}
	r.table = table
	c.mu.Lock()
	if c.gen == gen {
		c.table, c.at, c.refreshing = table, time.Now(), nil
	}
	c.mu.Unlock()
	close(r.done)
}

// invalidate forces the next get to re-read the table (a refresh already
// running is not cached).
func (c *arpCacheT) invalidate() {
	c.mu.Lock()
	c.table = nil
	c.gen++
	c.refreshing = nil
	c.mu.Unlock()
}

// arpLookupFresh returns the current ARP entry of one IP, bypassing the
// cache: Linux re-reads /proc/net/arp; Windows runs `arp -a <ip>`; macOS and
// the BSDs run `arp -n <ip>`. A missing or incomplete entry returns false.
func arpLookupFresh(ip string) (string, bool) {
	if net.ParseIP(ip).To4() == nil {
		return "", false
	}
	var table map[string]string
	switch runtime.GOOS {
	case "linux":
		table = readARPTableFn()
	case "windows":
		table = runARPCommand("-a", ip)
	default:
		table = runARPCommand("-n", ip)
	}
	mac, ok := table[ip]
	if !ok {
		// Behind a MikroTik (container): LAN hosts are routed, the router's
		// ARP table is the one that knows them.
		if routerOSEnabled() {
			return routerOSLookupIP(ip)
		}
		return "", false
	}
	mac = normalizeARPMac(mac)
	return mac, mac != ""
}

// runARPCommand runs `arp <flag> <ip>` (at most 5 s) and parses its output.
// "No ARP entries" is reported with a non-zero exit status: whatever was
// printed is still parsed, which yields no entry.
func runARPCommand(flag, ip string) map[string]string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, "arp", flag, ip).Output()
	return parseARPOutput(out)
}

// arpMacPattern matches MAC addresses with or without zero-padding
// (aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff, and macOS / BSD 0:8:e1:1:2:3), not
// embedded in a longer hex / colon sequence.
var arpMacPattern = regexp.MustCompile(`(?:^|[^0-9A-Fa-f:\-])((?:[0-9A-Fa-f]{1,2}[:\-]){5}[0-9A-Fa-f]{1,2})(?:$|[^0-9A-Fa-f:\-])`)

// arpIPPattern matches IPv4 addresses.
var arpIPPattern = regexp.MustCompile(`\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b`)

// parseARPOutput parses `arp -a` / `arp -n` output (Windows, macOS, BSD):
// one entry per line holding an IPv4 address and a MAC address. Returns
// ip → MAC (uppercase, colon-separated, zero-padded). Broadcast, all-zero and
// incomplete entries are skipped.
func parseARPOutput(out []byte) map[string]string {
	result := make(map[string]string)
	scanner := bufio.NewScanner(bytes.NewReader(out))
	for scanner.Scan() {
		line := scanner.Text()
		ipMatch := arpIPPattern.FindString(line)
		m := arpMacPattern.FindStringSubmatch(line)
		if ipMatch == "" || m == nil {
			continue
		}
		ip := net.ParseIP(ipMatch).To4()
		if ip == nil {
			continue
		}
		mac := normalizeARPMac(m[1])
		if mac == "" || mac == "FF:FF:FF:FF:FF:FF" || mac == "00:00:00:00:00:00" {
			continue
		}
		result[ip.String()] = mac
	}
	return result
}

// normalizeARPMac returns mac as uppercase, colon-separated, zero-padded
// octets ("0:8:e1:1:2:3" → "00:08:E1:01:02:03"), or "" when it is not a MAC.
func normalizeARPMac(mac string) string {
	parts := strings.FieldsFunc(strings.TrimSpace(mac), func(r rune) bool { return r == ':' || r == '-' })
	if len(parts) != 6 {
		return ""
	}
	var b strings.Builder
	b.Grow(17)
	for i, p := range parts {
		if len(p) == 0 || len(p) > 2 {
			return ""
		}
		for j := 0; j < len(p); j++ {
			c := p[j]
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
				return ""
			}
		}
		if i > 0 {
			b.WriteByte(':')
		}
		if len(p) == 1 {
			b.WriteByte('0')
		}
		b.WriteString(strings.ToUpper(p))
	}
	return b.String()
}
