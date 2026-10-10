package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"sync"
)

// ─── LAN target guard ────────────────────────────────────────────────────────
//
// Anything the server asks the probe to connect to (TCP tunnels today, device
// checks later) is re-validated locally: the probe only dials private IPv4
// hosts inside the subnets it actually scanned during its last scan cycle,
// never itself, never loopback / link-local / multicast / cloud metadata, and
// never an address the operator excluded. A compromised or confused server
// therefore cannot turn the probe into a pivot to arbitrary hosts.

// errTargetNotAllowed is the sentinel wrapped by every refusal returned from
// allowedLanTarget (use errors.Is). Its text is the code reported to the server.
var errTargetNotAllowed = errors.New("target_not_allowed")

// targetRefusal carries the precise reason for a refused target (for local logs).
type targetRefusal struct {
	ip     string
	reason string
}

func (e *targetRefusal) Error() string {
	return fmt.Sprintf("target %q not allowed: %s", e.ip, e.reason)
}

func (e *targetRefusal) Unwrap() error { return errTargetNotAllowed }

func refuseTarget(ip, reason string) error {
	return &targetRefusal{ip: ip, reason: reason}
}

// lastScanned holds the subnets scanned during the most recent scan cycle
// (after exclusions). Written by doScan, read by allowedLanTarget.
var lastScanned struct {
	sync.RWMutex
	nets []*net.IPNet
}

// setLastScannedSubnets records the subnets scanned by the latest scan cycle.
func setLastScannedSubnets(n []*net.IPNet) {
	cp := make([]*net.IPNet, 0, len(n))
	for _, sn := range n {
		if sn == nil {
			continue
		}
		ip4 := sn.IP.To4()
		if ip4 == nil {
			continue // IPv4 only
		}
		mask := sn.Mask
		if len(mask) == net.IPv6len {
			// IPv4 subnet expressed with a 16-byte mask (::ffff:… form).
			ones, bits := mask.Size()
			if bits != 8*net.IPv6len || ones < 96 {
				continue
			}
			mask = net.CIDRMask(ones-96, 8*net.IPv4len)
		}
		if len(mask) != net.IPv4len {
			continue
		}
		mask = append(net.IPMask(nil), mask...)
		cp = append(cp, &net.IPNet{IP: ip4.Mask(mask), Mask: mask})
	}
	lastScanned.Lock()
	lastScanned.nets = cp
	lastScanned.Unlock()
}

func lastScannedSubnets() []*net.IPNet {
	lastScanned.RLock()
	defer lastScanned.RUnlock()
	return lastScanned.nets
}

// localIPv4sFn returns every IPv4 address configured on this host. It is a
// variable so tests can substitute a fixed set.
var localIPv4sFn = allLocalIPv4s

// allLocalIPv4s returns every IPv4 address of every interface of this host,
// including loopback, down and virtual interfaces — a strict superset of
// probeLocalIPs(), which skips virtual interfaces such as docker bridges.
func allLocalIPv4s() []string {
	var ips []string
	ifaces, err := net.Interfaces()
	if err != nil {
		// Fall back to the reported addresses rather than to an empty set.
		return probeLocalIPs()
	}
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip4 := ip.To4(); ip4 != nil {
				ips = append(ips, ip4.String())
			}
		}
	}
	return ips
}

// cloudMetadataIP is the well-known instance metadata endpoint (AWS, GCP, Azure…).
var cloudMetadataIP = net.IPv4(169, 254, 169, 254)

// allowedLanTarget returns nil when ip may be dialed by the probe on behalf of
// the server, or an error wrapping errTargetNotAllowed otherwise. The target
// must be a canonical IPv4 literal, private (RFC 1918), not loopback /
// multicast / link-local / unspecified / broadcast / cloud metadata, not the
// network or broadcast address of its scanned subnet, not one of this host's
// own addresses, inside one of the subnets scanned by the last scan cycle,
// and not excluded by the server-provided exclusion list. Until a first scan
// has completed every target is refused.
func allowedLanTarget(ip string) error {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return refuseTarget(ip, "not an IP literal")
	}
	ip4 := parsed.To4()
	if ip4 == nil {
		return refuseTarget(ip, "not an IPv4 address")
	}
	canonical := ip4.String()
	if canonical != ip {
		// Reject IPv4-mapped IPv6 notation and any other non-canonical spelling.
		return refuseTarget(ip, "not a canonical dotted-quad IPv4 address")
	}

	switch {
	case ip4.IsUnspecified():
		return refuseTarget(ip, "unspecified address")
	case ip4.IsLoopback():
		return refuseTarget(ip, "loopback address")
	case ip4.IsMulticast():
		return refuseTarget(ip, "multicast address")
	case ip4.Equal(net.IPv4bcast):
		return refuseTarget(ip, "broadcast address")
	case ip4.Equal(cloudMetadataIP):
		return refuseTarget(ip, "cloud metadata address")
	case ip4.IsLinkLocalUnicast():
		return refuseTarget(ip, "link-local address")
	}
	if !isPrivateIPv4(canonical) {
		return refuseTarget(ip, "not a private (RFC 1918) address")
	}

	nets := lastScannedSubnets()
	if len(nets) == 0 {
		return refuseTarget(ip, "no scan has completed yet")
	}
	inside := false
	for _, sn := range nets {
		if !sn.Contains(ip4) {
			continue
		}
		inside = true
		ones, bits := sn.Mask.Size()
		if bits == 32 && ones <= 30 {
			netAddr := binary.BigEndian.Uint32(sn.IP.To4())
			bcast := netAddr | ^binary.BigEndian.Uint32(sn.Mask)
			addr := binary.BigEndian.Uint32(ip4)
			if addr == netAddr {
				return refuseTarget(ip, fmt.Sprintf("network address of %s", sn))
			}
			if addr == bcast {
				return refuseTarget(ip, fmt.Sprintf("broadcast address of %s", sn))
			}
		}
	}
	if !inside {
		return refuseTarget(ip, "outside the subnets scanned by this probe")
	}

	for _, own := range localIPv4sFn() {
		if own == canonical {
			return refuseTarget(ip, "address of the probe host itself")
		}
	}

	if isExcluded(canonical + "/32") {
		return refuseTarget(ip, "excluded by the subnet exclusion list")
	}
	return nil
}
