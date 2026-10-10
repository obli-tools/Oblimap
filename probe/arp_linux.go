//go:build linux

package main

import (
	"bufio"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
)

// atfCom is ATF_COM in the Flags column of /proc/net/arp: the entry is
// complete — its neighbour state is REACHABLE, STALE, DELAY, PROBE (0x2) or
// PERMANENT (0x6). Incomplete and failed entries show 0x0, and a failed
// entry may still print the MAC address it had before: the MAC column alone
// cannot tell them apart.
//
// A complete entry is not proof that the host is up: the kernel keeps STALE
// entries of hosts long gone (flags 0x2) until it has to re-validate them.
// scanSubnets (network_scan.go) therefore only trusts an entry refreshed by
// its own scan.
const atfCom = 0x2

// readARPTable parses /proc/net/arp on Linux.
// Returns a map of ip → mac (uppercase, colon-separated, zero-padded) of the
// complete entries only.
func readARPTable() map[string]string {
	f, err := os.Open("/proc/net/arp")
	if err != nil {
		return make(map[string]string)
	}
	defer f.Close()
	return parseProcNetARP(f)
}

// parseProcNetARP parses the /proc/net/arp format:
//
//	IP address       HW type     Flags       HW address            Mask     Device
//	192.168.1.1      0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0
//
// Entries without ATF_COM (incomplete, failed), with an unparseable flags
// field or an all-zero / broadcast MAC are skipped.
func parseProcNetARP(r io.Reader) map[string]string {
	result := make(map[string]string)

	scanner := bufio.NewScanner(r)
	// Skip header line
	scanner.Scan()
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 {
			continue
		}
		flags, err := strconv.ParseUint(fields[2], 0, 32)
		if err != nil || flags&atfCom == 0 {
			continue
		}
		ip := net.ParseIP(fields[0]).To4()
		if ip == nil {
			continue
		}
		mac := normalizeARPMac(fields[3])
		if mac == "" || mac == "00:00:00:00:00:00" || mac == "FF:FF:FF:FF:FF:FF" {
			continue
		}
		result[ip.String()] = mac
	}
	return result
}
