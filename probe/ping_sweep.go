package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os/exec"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// ─── ICMP ping sweep (routed subnets) ────────────────────────────────────────
//
// Beyond the local link there is no ARP evidence: a firewalled host, or one
// with none of probePorts open, never answers the TCP probe. The hosts of
// subnets that are not directly connected (extra subnets reached through a
// router) and stayed silent to TCP are pinged with the OS ping command —
// unprivileged, like Obliance's agent — never through a shell.

// pingSweepConcurrency is the number of ping processes run at once.
const pingSweepConcurrency = 32

// pingSweepBudget is the time a scan cycle may spend pinging; the hosts not
// reached within it are left for the next cycle (logged).
const pingSweepBudget = 60 * time.Second

// pingProcessTimeout kills a ping process that outlives its own timeout.
const pingProcessTimeout = 3 * time.Second

// pingHostFn pings one host: true when it answered. A non-nil error means
// the ping command itself could not run (missing binary…). A variable so
// tests can substitute it.
var pingHostFn = pingHost

// pingArgs returns the arguments of a single ping with a short timeout:
// Windows `-n 1 -w 500` (ms), Linux `-c 1 -W 1` (s), macOS / BSD
// `-c 1 -t 1` (s).
func pingArgs(goos, ip string) []string {
	switch goos {
	case "windows":
		return []string{"-n", "1", "-w", "500", ip}
	case "linux":
		return []string{"-c", "1", "-W", "1", ip}
	default: // darwin, freebsd and the other BSDs
		return []string{"-c", "1", "-t", "1", ip}
	}
}

// pingHost runs one OS ping of ip (an IPv4 literal: never a flag, never
// handed to a shell) and reads its exit code. Windows ping also exits 0
// when a router answers "Destination host unreachable" in the target's
// place, so there a success also needs an echo reply line ("TTL=", the
// same in every language).
func pingHost(ctx context.Context, ip string) (bool, error) {
	pctx, cancel := context.WithTimeout(ctx, pingProcessTimeout)
	defer cancel()
	cmd := exec.CommandContext(pctx, pingCommandPath(), pingArgs(runtime.GOOS, ip)...)
	configurePingCmd(cmd)

	var err error
	var out []byte
	if runtime.GOOS == "windows" {
		out, err = cmd.Output()
	} else {
		err = cmd.Run()
	}
	if err == nil {
		return runtime.GOOS != "windows" || bytes.Contains(out, []byte("TTL=")), nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) || pctx.Err() != nil {
		return false, nil // no answer (or killed at the timeout)
	}
	return false, err
}

// pingSweep pings ips, pingSweepConcurrency at a time, until budget runs
// out. Returns the IPs that answered, the number of IPs not pinged, and
// whether the sweep stopped because the ping command cannot run on this
// host (otherwise the IPs not pinged are the ones the budget did not reach).
func pingSweep(ips []net.IP, budget time.Duration) (alive map[string]bool, notTried int, unavailableErr error) {
	alive = make(map[string]bool)
	if len(ips) == 0 {
		return alive, 0, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()

	jobs := make(chan string)
	var mu sync.Mutex
	var skipped atomic.Int64
	var unavailable sync.Once
	var wg sync.WaitGroup
	workers := pingSweepConcurrency
	if len(ips) < workers {
		workers = len(ips)
	}
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ip := range jobs {
				if ctx.Err() != nil {
					skipped.Add(1)
					continue
				}
				ok, err := pingHostFn(ctx, ip)
				if err != nil {
					// The ping command cannot run here: stop the sweep.
					unavailable.Do(func() {
						mu.Lock()
						unavailableErr = err
						mu.Unlock()
					})
					skipped.Add(1)
					cancel()
					continue
				}
				if ok {
					mu.Lock()
					alive[ip] = true
					mu.Unlock()
				}
			}
		}()
	}
	for _, ip := range ips {
		jobs <- ip.String()
	}
	close(jobs)
	wg.Wait()
	return alive, int(skipped.Load()), unavailableErr
}
