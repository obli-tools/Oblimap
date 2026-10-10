package main

import (
	"context"
	"encoding/binary"
	"errors"
	"log"
	"net"
	"sort"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// ─── Host IP enumeration ──────────────────────────────────────────────────────

// maxFullScanHostBits is the widest subnet scanned host by host: /18, 16382
// hosts, swept in /24 blocks. A wider subnet is scanned only in the /24
// blocks where a host is already known (see planSubnet).
const maxFullScanHostBits = 14

// maxScanHostsPerSubnet is the hard cap of addresses dialed per subnet and
// per scan cycle (64 /24 blocks).
const maxScanHostsPerSubnet = 16384

// scanBlockBits is the size of a scan block: subnets wider than /24 are
// swept one /24 at a time.
const scanBlockBits = 8

// skipReasonTooWide marks a subnet wider than /18: only the /24 blocks that
// hold a known host (ARP table, the probe's own addresses) were scanned.
const skipReasonTooWide = "too_wide"

// skipReasonCycleBudget marks a subnet left out of this cycle because the
// subnets before it already fill the cycle's time budget (see
// cycleBlockBudget).
const skipReasonCycleBudget = "cycle_budget"

// blockSweepCost is the worst-case time of the TCP sweep of one /24 block
// whose hosts are all silent: every probe port times out, pingConcurrency
// hosts at a time.
var blockSweepCost = time.Duration((1<<scanBlockBits+pingConcurrency-1)/pingConcurrency*len(probePorts)) * tcpTimeout

// cycleBlockBudget is the number of /24 blocks one scan cycle may sweep:
// what fits in 3/4 of the scan interval at blockSweepCost per block (an
// HTTP-mode probe only contacts the server after its scan, a cycle much
// longer than the interval gets it declared offline). Never less than one
// full subnet of maxScanHostsPerSubnet hosts.
func cycleBlockBudget(interval time.Duration) int {
	floor := maxScanHostsPerSubnet >> scanBlockBits
	if interval <= 0 || blockSweepCost <= 0 {
		return floor
	}
	if n := int(interval * 3 / 4 / blockSweepCost); n > floor {
		return n
	}
	return floor
}

// subnetPlan is the planned sweep of one subnet.
type subnetPlan struct {
	subnet *net.IPNet
	chunks []*net.IPNet // /24 blocks (or the subnet itself) to sweep
	skip   *SkippedSubnet
	own    bool // holds one of the probe's own addresses
}

// applyCycleBudget keeps the plans that fit in budget /24 blocks: the
// subnets of the probe's own interfaces first, then the others in their
// order. A subnet is kept whole or left out whole (reported skipped
// "cycle_budget"), so the same hosts are swept every cycle (no flapping of
// the tail of a subnet). The first subnet kept is kept even when it alone
// exceeds the budget.
func applyCycleBudget(plans []*subnetPlan, budget int) (kept []*subnetPlan, skipped []SkippedSubnet) {
	used := 0
	keep := make([]bool, len(plans))
	for pass := 0; pass < 2; pass++ {
		for i, p := range plans {
			if p.own != (pass == 0) {
				continue
			}
			n := len(p.chunks)
			if used > 0 && used+n > budget {
				continue
			}
			used += n
			keep[i] = true
		}
	}
	for i, p := range plans {
		if keep[i] {
			kept = append(kept, p)
			continue
		}
		cidr := p.subnet.String()
		if sn := ipv4Net(p.subnet); sn != nil {
			cidr = sn.String()
		}
		skipped = append(skipped, SkippedSubnet{CIDR: cidr, Reason: skipReasonCycleBudget})
	}
	return kept, skipped
}

// ipv4Net returns n as a canonical IPv4 network (4-byte address masked by a
// 4-byte mask), or nil when n is not IPv4 or its mask is not a CIDR mask.
func ipv4Net(n *net.IPNet) *net.IPNet {
	if n == nil {
		return nil
	}
	ip4 := n.IP.To4()
	if ip4 == nil {
		return nil
	}
	mask := n.Mask
	if len(mask) == net.IPv6len {
		// IPv4 subnet expressed with a 16-byte mask (::ffff:… form).
		ones, bits := mask.Size()
		if bits != 8*net.IPv6len || ones < 96 {
			return nil
		}
		mask = net.CIDRMask(ones-96, 8*net.IPv4len)
	}
	if len(mask) != net.IPv4len {
		return nil
	}
	if _, bits := mask.Size(); bits == 0 {
		return nil // non-contiguous mask
	}
	mask = append(net.IPMask(nil), mask...)
	return &net.IPNet{IP: ip4.Mask(mask), Mask: mask}
}

func ipToUint32(ip net.IP) uint32 { return binary.BigEndian.Uint32(ip.To4()) }

func uint32ToIP(v uint32) net.IP {
	ip := make(net.IP, 4)
	binary.BigEndian.PutUint32(ip, v)
	return ip
}

// planSubnet splits subnet into the blocks this scan cycle sweeps:
//   - up to /24: the subnet itself;
//   - /23 to /18 (at most maxFullScanHostBits host bits): every /24 block;
//   - wider: only the /24 blocks holding one of the probe's own addresses
//     (first) or a known host (ARP table), at most maxScanHostsPerSubnet
//     addresses; the subnet is then reported skipped ("too_wide") because
//     the rest of it is not scanned.
//
// Blocks that the exclusion list covers (excluded, may be nil) are left
// out; exclusions of the whole subnet are applied by the caller.
func planSubnet(subnet *net.IPNet, own, known []net.IP, excluded func(string) bool) ([]*net.IPNet, *SkippedSubnet) {
	sn := ipv4Net(subnet)
	if sn == nil {
		return nil, nil // IPv6 not supported
	}
	ones, _ := sn.Mask.Size()
	hostBits := 32 - ones
	if hostBits <= scanBlockBits {
		return []*net.IPNet{sn}, nil
	}

	base := ipToUint32(sn.IP)
	const blockMask = ^uint32(1<<scanBlockBits - 1)
	var blocks []uint32
	var skipped *SkippedSubnet
	if hostBits <= maxFullScanHostBits {
		n := uint32(1) << uint(hostBits-scanBlockBits)
		for i := uint32(0); i < n; i++ {
			blocks = append(blocks, base+i<<scanBlockBits)
		}
	} else {
		skipped = &SkippedSubnet{CIDR: sn.String(), Reason: skipReasonTooWide}
		maxBlocks := maxScanHostsPerSubnet >> scanBlockBits
		seen := make(map[uint32]bool)
		add := func(ips []net.IP, sorted bool) {
			var found []uint32
			for _, ip := range ips {
				ip4 := ip.To4()
				if ip4 == nil || !sn.Contains(ip4) {
					continue
				}
				b := ipToUint32(ip4) & blockMask
				if !seen[b] {
					seen[b] = true
					found = append(found, b)
				}
			}
			if sorted {
				sort.Slice(found, func(i, j int) bool { return found[i] < found[j] })
			}
			for _, b := range found {
				if len(blocks) >= maxBlocks {
					return
				}
				blocks = append(blocks, b)
			}
		}
		add(own, false) // the probe's own /24 first: never lost to the cap
		add(known, true)
		sort.Slice(blocks, func(i, j int) bool { return blocks[i] < blocks[j] })
	}

	chunks := make([]*net.IPNet, 0, len(blocks))
	for _, b := range blocks {
		chunk := &net.IPNet{IP: uint32ToIP(b), Mask: net.CIDRMask(32-scanBlockBits, 32)}
		if excluded != nil && excluded(chunk.String()) {
			continue
		}
		chunks = append(chunks, chunk)
	}
	return chunks, skipped
}

// blockHosts returns the host addresses of block, a part of parent (or
// parent itself): every address of the block except the network and
// broadcast addresses of parent. A /31 or /32 parent has no host to scan.
func blockHosts(parent, block *net.IPNet) []net.IP {
	p, b := ipv4Net(parent), ipv4Net(block)
	if p == nil || b == nil || !p.Contains(b.IP) {
		return nil
	}
	pNet := ipToUint32(p.IP)
	pBcast := pNet | ^ipToUint32(net.IP(p.Mask))
	bNet := ipToUint32(b.IP)
	bBcast := bNet | ^ipToUint32(net.IP(b.Mask))
	if bBcast > pBcast {
		bBcast = pBcast // block wider than its parent
	}
	var ips []net.IP
	for addr := bNet; ; addr++ {
		if addr != pNet && addr != pBcast {
			ips = append(ips, uint32ToIP(addr))
		}
		if addr == bBcast || len(ips) >= maxScanHostsPerSubnet {
			break
		}
	}
	return ips
}

// inNets reports whether ip lies inside one of nets.
func inNets(ip net.IP, nets []*net.IPNet) bool {
	for _, n := range nets {
		if n != nil && n.Contains(ip) {
			return true
		}
	}
	return false
}

// containsAny reports whether one of ips lies inside n.
func containsAny(n *net.IPNet, ips []net.IP) bool {
	for _, ip := range ips {
		if n != nil && n.Contains(ip) {
			return true
		}
	}
	return false
}

// ─── Network Scan ─────────────────────────────────────────────────────────────

const pingConcurrency = 256
const tcpTimeout = 250 * time.Millisecond
const dnsTimeout = 1 * time.Second

// arpSettleDelay is how long after the TCP sweep the ARP table is read a
// last time, to re-validate the entries that already existed before the
// scan. Sending to a stale entry makes the OS re-check it: Linux (Windows
// alike) moves it to DELAY, unicast-probes it (by default 5 s + 3 × 1 s) and
// marks it FAILED — incomplete, left out by readARPTable — when nobody
// answers. A host silent to TCP is dialed for at most ~3.3 s (probePorts ×
// tcpTimeout), so 9 s after the sweep each such entry was confirmed or failed.
const arpSettleDelay = 9 * time.Second

// subnetSweep is one subnet of a scanSubnets call.
type subnetSweep struct {
	subnet  *net.IPNet
	chunks  []*net.IPNet    // the blocks actually dialed (ARP evidence only there)
	alive   map[string]bool // answered TCP (or ping, routed hosts)
	online  map[string]bool // alive, or ARP evidence from this scan
	pending []string        // ARP entries to re-validate (see arpEvidence)
	silent  []net.IP        // routed hosts silent to TCP: ping sweep candidates
}

// scanSubnets discovers the devices of the subnets that are online NOW.
// localNets are the subnets of the probe's own interfaces: a host outside
// them is routed (no ARP evidence possible) and is pinged when it does not
// answer TCP. Returns the devices and the subnets (partly) left out of the
// scan with the reason. interval is the scan interval: the cycle sweeps at
// most cycleBlockBudget(interval) /24 blocks (subnets beyond are skipped
// "cycle_budget"). The subnets are swept one after the other, but the
// ARP table is read three times per call and the re-validation wait
// (arpSettleDelay) happens once, after the last sweep, whatever the number
// of subnets.
// Strategy:
//  1. ARP snapshot before the first sweep: what the OS already knew (it also
//     tells which /24 blocks of a subnet too wide to scan hold known hosts).
//  2. Concurrent TCP probe of every host, subnet by subnet, /24 block by /24
//     block (see planSubnet). A host that accepts the connection, or refuses
//     it (TCP RST), is alive. Besides finding the hosts that answer, it makes
//     the OS resolve (or re-validate) the ARP entry of every host it sends to.
//  3. ARP table right after the TCP sweeps, for MAC addresses (works
//     without root), before the ping sweep so that the entries of the local
//     link are not garbage-collected meanwhile.
//  4. Ping sweep (OS ping command, time-boxed) of the routed hosts that did
//     not answer TCP (see pingSweep).
//  5. A device counts online only when it answered TCP / ping in this scan,
//     or has a complete ARP entry refreshed during this scan (see
//     arpEvidence; only addresses of the blocks actually dialed — an entry
//     in an excluded or unplanned block was never re-validated by the OS):
//     absent before the scan, or with another MAC — the host
//     answered this sweep's ARP request. An entry already there before
//     proves nothing on its own: the OS keeps stale entries of hosts long
//     gone (Linux shows them complete until it re-validates them), which
//     used to report devices online forever. Such an entry counts only when
//     it is still complete arpSettleDelay after the last sweep (its own
//     sweep ended earlier still), once the OS re-checked it.
//     Devices that are not online are left out of the report: the server
//     counts a missed scan for them (offline after maxMissedPushes misses).
//  6. Optional full port scan of the hosts that answered (runs while the OS
//     re-validates the pending entries).
//  7. Reverse DNS lookup for hostnames.
//
// Devices are returned subnet by subnet, in the order of subnets.
func scanSubnets(subnets []*net.IPNet, localNets []*net.IPNet, interval time.Duration) ([]DiscoveredDevice, []SkippedSubnet) {
	if len(subnets) == 0 {
		return nil, nil
	}

	// Step 1: ARP entries that predate this scan
	arpBefore := readARPTable()
	known := make([]net.IP, 0, len(arpBefore))
	for ip := range arpBefore {
		if parsed := net.ParseIP(ip); parsed != nil {
			known = append(known, parsed)
		}
	}
	var own []net.IP
	for _, ip := range localIPv4sFn() {
		if parsed := net.ParseIP(ip); parsed != nil {
			own = append(own, parsed)
		}
	}

	var plans []*subnetPlan
	for _, subnet := range subnets {
		chunks, skip := planSubnet(subnet, own, known, isExcluded)
		plans = append(plans, &subnetPlan{subnet: subnet, chunks: chunks, skip: skip, own: containsAny(subnet, own)})
	}
	plans, skipped := applyCycleBudget(plans, cycleBlockBudget(interval))
	for _, sk := range skipped {
		log.Printf("WARN: subnet %s left out of this scan cycle: the subnets before it already fill the cycle's time budget (3/4 of the %s scan interval)",
			sk.CIDR, interval)
	}

	var sweeps []*subnetSweep
	var sweepEnd time.Time
	for _, plan := range plans {
		subnet, chunks, skip := plan.subnet, plan.chunks, plan.skip
		if skip != nil {
			skipped = append(skipped, *skip)
			log.Printf("WARN: subnet %s is too wide to scan entirely (more than /%d): scanning only the %d /24 blocks with known hosts, the rest is skipped",
				skip.CIDR, 32-maxFullScanHostBits, len(chunks))
		}
		blocks := make([][]net.IP, 0, len(chunks))
		total := 0
		for _, chunk := range chunks {
			if ips := blockHosts(subnet, chunk); len(ips) > 0 {
				blocks = append(blocks, ips)
				total += len(ips)
			}
		}
		if total == 0 {
			continue
		}

		log.Printf("Scanning %s (%d hosts)…", subnet, total)

		// Step 2: Concurrent TCP probe (also populates / re-validates the ARP cache)
		s := &subnetSweep{subnet: subnet, chunks: chunks, alive: make(map[string]bool)}
		for _, ips := range blocks {
			open, refused := tcpScan(ips)
			for ip := range open {
				s.alive[ip] = true
			}
			if refusedFlood(len(ips), refused) {
				log.Printf("WARN: %d of %d hosts of a block of %s refused TCP on every probed port — most likely a firewall answering for them, refusals ignored",
					len(refused), len(ips), subnet)
			} else {
				for ip := range refused {
					s.alive[ip] = true
				}
			}
			for _, ip := range ips {
				if !s.alive[ip.String()] && !inNets(ip, localNets) {
					s.silent = append(s.silent, ip)
				}
			}
		}
		sweeps = append(sweeps, s)
		sweepEnd = time.Now()
	}
	if len(sweeps) == 0 {
		return nil, skipped
	}

	// Step 3: Read ARP table — MAC of every IP the OS resolved. Read before
	// the ping sweep (up to pingSweepBudget): local-link entries of hosts
	// silent to TCP must not age out meanwhile.
	arpTable := readARPTable()
	if arpTable == nil {
		arpTable = make(map[string]string)
	}
	pending := 0
	for _, s := range sweeps {
		s.online = make(map[string]bool, len(s.alive))
		var fresh []string
		fresh, s.pending = arpEvidence(s.chunks, s.alive, arpBefore, arpTable)
		for _, ip := range fresh {
			s.online[ip] = true
		}
		pending += len(s.pending)
	}

	// Step 4: Ping sweep of the routed hosts silent to TCP (no ARP evidence
	// beyond the local link)
	var candidates []net.IP
	for _, s := range sweeps {
		candidates = append(candidates, s.silent...)
	}
	if len(candidates) > 0 {
		pinged, notTried, pingErr := pingSweep(candidates, pingSweepBudget)
		if pingErr != nil {
			log.Printf("WARN: ping sweep disabled for this cycle, the ping command cannot run: %v (%d routed hosts not pinged)", pingErr, notTried)
		} else if notTried > 0 {
			log.Printf("WARN: ping sweep budget (%s) exhausted: %d routed hosts not pinged this cycle", pingSweepBudget, notTried)
		}
		for _, s := range sweeps {
			for _, ip := range s.silent {
				if pinged[ip.String()] {
					s.alive[ip.String()] = true
				}
			}
			s.silent = nil
		}
	}

	allAlive := make(map[string]bool)
	for _, s := range sweeps {
		for ip := range s.alive {
			s.online[ip] = true
			allAlive[ip] = true
		}
	}

	// Step 6 (optional): Full port scan for alive IPs (runs while the OS
	// re-validates the pending ARP entries)
	var portScanResults map[string][]int
	if portScanEnabled, portScanPorts := portScanSettings(); portScanEnabled && len(portScanPorts) > 0 {
		log.Printf("  Port scanning %d alive hosts on %d ports…", len(allAlive), len(portScanPorts))
		portScanResults = tcpScanPorts(allAlive, portScanPorts)
	}

	// Step 5: Re-validate the ARP entries that predate the scan, once for
	// every subnet
	if pending > 0 {
		if wait := arpSettleDelay - time.Since(sweepEnd); wait > 0 {
			time.Sleep(wait)
		}
		final := readARPTable()
		for _, s := range sweeps {
			stale := 0
			for _, ip := range s.pending {
				if mac, ok := final[ip]; ok {
					s.online[ip] = true
					arpTable[ip] = mac
				} else {
					stale++
				}
			}
			if stale > 0 {
				log.Printf("  %d stale ARP entries ignored in %s", stale, s.subnet)
			}
		}
	}

	allOnline := make(map[string]bool)
	for _, s := range sweeps {
		for ip := range s.online {
			allOnline[ip] = true
		}
	}
	if len(allOnline) == 0 {
		return nil, skipped
	}

	// Step 7: Reverse DNS (concurrent)
	hostnameMap := resolveHostnames(allOnline)

	// Build the device list (online devices only)
	var devices []DiscoveredDevice
	for _, s := range sweeps {
		if len(s.online) == 0 {
			continue
		}
		for ipStr := range s.online {
			d := DiscoveredDevice{
				IP:       ipStr,
				MAC:      arpTable[ipStr],
				Hostname: hostnameMap[ipStr],
				IsOnline: true,
			}
			if portScanResults != nil {
				if ports, ok := portScanResults[ipStr]; ok {
					d.OpenPorts = ports
				} else {
					d.OpenPorts = []int{} // scanned but nothing open
				}
			}
			devices = append(devices, d)
		}
		log.Printf("  → %d devices found in %s", len(s.online), s.subnet)
	}
	return devices, skipped
}

// arpEvidence sorts the complete ARP entries (after the sweep) of the hosts
// that did not answer TCP, inside the blocks actually dialed (dialed) —
// an entry elsewhere (excluded block, block of a too-wide subnet not
// planned) was never re-validated by the OS and proves nothing:
//   - fresh: resolved during this scan (absent before, or another MAC) —
//     the host answered an ARP request of this sweep: online;
//   - pending: the same entry existed before the scan — possibly stale, to
//     re-validate after arpSettleDelay.
func arpEvidence(dialed []*net.IPNet, alive map[string]bool, before, after map[string]string) (fresh, pending []string) {
	for ip, mac := range after {
		if alive[ip] {
			continue
		}
		parsed := net.ParseIP(ip)
		if parsed == nil || !inNets(parsed, dialed) {
			continue
		}
		if prev, ok := before[ip]; ok && prev == mac {
			pending = append(pending, ip)
		} else {
			fresh = append(fresh, ip)
		}
	}
	return fresh, pending
}

// ─── TCP Port Scan ────────────────────────────────────────────────────────────

// scanDialFn dials one probe port of tcpScan (a variable so tests can
// substitute it).
var scanDialFn = net.DialTimeout

// Common ports to try — a device is "online" if any port responds.
var probePorts = []int{22, 80, 443, 445, 8080, 8443, 554, 21, 23, 3389, 9100, 515, 631}

// isConnRefused reports whether a dial error is a refused connection: the
// host answered the SYN with a TCP RST, so it is up even though the port is
// closed. Windows reports WSAECONNREFUSED (see isConnRefusedOS).
func isConnRefused(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, syscall.ECONNREFUSED) || isConnRefusedOS(err)
}

// refusedFlood tells whether the refusals of a block are too many to be
// genuine: when nearly every address of a block of 64+ hosts refuses the
// connection, a firewall or router is answering with RST for addresses
// nobody uses, and counting them would report phantom devices.
func refusedFlood(hosts int, refused map[string]bool) bool {
	return hosts >= 64 && len(refused)*10 >= hosts*9
}

// tcpScan concurrently probes all IPs on common ports. Returns the IPs that
// accepted a connection (open) and those that only refused (refused, TCP
// RST: up, no probed port open). A host stops being probed at its first
// open port only: a refusal does not end the probe, so a host whose first
// ports are closed is still found open on a later one (and counted even
// when refusedFlood drops the refusals of its block). RSTs come back at
// once, so this costs little.
//
// Windows note: the Windows TCP stack may retry a SYN answered by a RST
// from a remote host beyond tcpTimeout, so refusals are seen less often
// there; such a host is then found by its ARP entry (local link) or the
// ping sweep (routed).
func tcpScan(ips []net.IP) (open, refused map[string]bool) {
	open = make(map[string]bool)
	refused = make(map[string]bool)
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, pingConcurrency)

	for _, ip := range ips {
		wg.Add(1)
		sem <- struct{}{}
		go func(target net.IP) {
			defer wg.Done()
			defer func() { <-sem }()

			ipStr := target.String()
			sawRefused := false
			for _, port := range probePorts {
				addr := net.JoinHostPort(ipStr, strconv.Itoa(port))
				conn, err := scanDialFn("tcp", addr, tcpTimeout)
				if err == nil {
					conn.Close()
					mu.Lock()
					open[ipStr] = true
					mu.Unlock()
					return // Found online on one port — no need to check others
				}
				if isConnRefused(err) {
					sawRefused = true // up (RST), but an open port may follow
				}
			}
			if sawRefused {
				mu.Lock()
				refused[ipStr] = true
				mu.Unlock()
			}
		}(cloneIP(ip))
	}

	wg.Wait()
	return open, refused
}

// ─── Full Port Scan ───────────────────────────────────────────────────────────

// tcpScanPorts scans all given ports for each IP in the aliveIPs set.
// Returns a map of ip → sorted list of open port numbers.
// Only called when cachedPortScanEnabled is true.
func tcpScanPorts(aliveIPs map[string]bool, ports []int) map[string][]int {
	if len(ports) == 0 {
		return nil
	}
	results := make(map[string][]int)
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, pingConcurrency)

	for ipStr := range aliveIPs {
		wg.Add(1)
		sem <- struct{}{}
		go func(target string) {
			defer wg.Done()
			defer func() { <-sem }()

			var open []int
			for _, port := range ports {
				addr := net.JoinHostPort(target, strconv.Itoa(port))
				conn, err := net.DialTimeout("tcp", addr, tcpTimeout)
				if err == nil {
					conn.Close()
					open = append(open, port)
				}
			}
			if len(open) > 0 {
				mu.Lock()
				results[target] = open
				mu.Unlock()
			}
		}(ipStr)
	}

	wg.Wait()
	return results
}

// ─── Hostname Resolution ──────────────────────────────────────────────────────

func resolveHostnames(ips map[string]bool) map[string]string {
	const concurrency = 64
	results := make(map[string]string)
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, concurrency)

	resolver := &net.Resolver{}

	for ipStr := range ips {
		wg.Add(1)
		sem <- struct{}{}
		go func(ip string) {
			defer wg.Done()
			defer func() { <-sem }()

			ctx, cancel := context.WithTimeout(context.Background(), dnsTimeout)
			defer cancel()

			names, err := resolver.LookupAddr(ctx, ip)
			if err != nil || len(names) == 0 {
				return
			}
			name := names[0]
			// Strip trailing dot from FQDN
			if len(name) > 0 && name[len(name)-1] == '.' {
				name = name[:len(name)-1]
			}
			mu.Lock()
			results[ip] = name
			mu.Unlock()
		}(ipStr)
	}

	wg.Wait()
	return results
}

// cloneIP returns a copy of a net.IP slice.
func cloneIP(ip net.IP) net.IP {
	if ip == nil {
		return nil
	}
	c := make(net.IP, len(ip))
	copy(c, ip)
	return c
}
