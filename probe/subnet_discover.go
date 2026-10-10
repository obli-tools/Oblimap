package main

import (
	"log"
	"net"
)

// discoverSubnets returns the list of IPv4 subnets to scan, and the subnets
// of the local interfaces among them (directly connected: ARP evidence is
// available there, the other hosts are routed).
// It enumerates all network interfaces, finds IPv4 addresses, and returns their
// subnets with the interface masks as they are (a wide LAN is split or
// limited by planSubnet, network_scan.go). Extra subnets from the server
// config are appended. The exclusions are applied by the caller (doScan).
func discoverSubnets(_ int) (subnets []*net.IPNet, local []*net.IPNet) {
	seen := make(map[string]bool)

	ifaces, err := net.Interfaces()
	if err != nil {
		log.Printf("WARN: could not list interfaces: %v", err)
		return nil, nil
	}

	for _, iface := range ifaces {
		// Skip loopback, down, and virtual interfaces
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		if isVirtualInterface(iface.Name) {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}

		for _, addr := range addrs {
			var ipNet *net.IPNet
			switch v := addr.(type) {
			case *net.IPNet:
				ipNet = v
			case *net.IPAddr:
				ipNet = &net.IPNet{IP: v.IP, Mask: v.IP.DefaultMask()}
			}
			if ipNet == nil {
				continue
			}

			// Network address with a 4-byte mask; nil for IPv6
			subnet := ipv4Net(ipNet)
			if subnet == nil {
				continue // Skip IPv6
			}
			key := subnet.String()

			if seen[key] {
				continue
			}
			seen[key] = true

			log.Printf("Discovered local subnet: %s (interface: %s)", key, iface.Name)
			subnets = append(subnets, subnet)
			local = append(local, subnet)
		}
	}

	// Append extra subnets from server config
	for _, extra := range cachedExtra {
		_, parsed, err := net.ParseCIDR(extra)
		if err != nil {
			log.Printf("WARN: invalid extra subnet %q: %v", extra, err)
			continue
		}
		subnet := ipv4Net(parsed)
		if subnet == nil {
			log.Printf("WARN: extra subnet %q is not IPv4, ignored", extra)
			continue
		}
		key := subnet.String()
		if !seen[key] {
			seen[key] = true
			log.Printf("Adding extra subnet: %s", key)
			subnets = append(subnets, subnet)
		}
	}

	return subnets, local
}

// isVirtualInterface returns true for known virtual/tunnel interfaces to skip.
func isVirtualInterface(name string) bool {
	prefixes := []string{
		"docker", "br-", "veth", "virbr", "lo", "tun", "tap",
		"vmnet", "vboxnet", "utun", "ipsec", "ppp", "wg",
		"epair", "pflog", "pfsync", "enc", "gif", "gre",
	}
	for _, prefix := range prefixes {
		if len(name) >= len(prefix) && name[:len(prefix)] == prefix {
			return true
		}
	}
	return false
}
