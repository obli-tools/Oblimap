package main

// RouterOS (MikroTik) collector.
//
// When the probe runs in a RouterOS v7 container — or anywhere it can reach a
// MikroTik router — it reads the router's own tables through the RouterOS
// REST API instead of relying only on its own scan:
//
//	GET /rest/ip/arp                 ARP table of every interface / VLAN
//	GET /rest/ip/dhcp-server/lease   DHCP leases (host names)
//	GET /rest/ip/address             router addresses → subnets to report / scan
//
// A probe in a container sits behind a virtual bridge: it cannot read the
// router's ARP table and its own ARP only covers that bridge, so without this
// collector it would see almost nothing.
//
// Configuration (environment, set on the container):
//
//	OBLIMAP_ROUTEROS_URL       e.g. https://172.17.0.1 (the router as seen from the container)
//	OBLIMAP_ROUTEROS_USER      a read-only RouterOS user (group "read" + policy "rest-api")
//	OBLIMAP_ROUTEROS_PASSWORD
//	OBLIMAP_ROUTEROS_INSECURE  "1" to accept the router's self-signed certificate
//
// Requests only ever go to the configured URL (no redirects, no proxy), with a
// short timeout and a response size cap. The password is never logged.

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// routerOSCapability is advertised in hello / push capabilities when the
// collector is configured (the server shows the probe as a MikroTik probe).
const routerOSCapability = "routeros:1"

const (
	routerOSTimeout      = 15 * time.Second
	routerOSMaxBody      = 16 << 20 // 16 MiB: large ARP / lease tables
	routerOSMaxEntries   = 20000
	routerOSWarnInterval = 30 * time.Minute
)

type routerOSConfig struct {
	base     *url.URL
	user     string
	password string
	insecure bool
}

var (
	routerOSOnce   sync.Once
	routerOSCfg    *routerOSConfig
	routerOSClient *http.Client
	routerOSWarnMu sync.Mutex
	routerOSWarnAt time.Time
)

// loadRouterOSConfig reads the environment once. nil when not configured or
// invalid (logged once).
func loadRouterOSConfig() *routerOSConfig {
	routerOSOnce.Do(func() {
		raw := strings.TrimSpace(os.Getenv("OBLIMAP_ROUTEROS_URL"))
		if raw == "" {
			return
		}
		u, err := url.Parse(strings.TrimRight(raw, "/"))
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil || u.RawQuery != "" {
			log.Printf("RouterOS: OBLIMAP_ROUTEROS_URL is not a plain http(s) URL — collector disabled")
			return
		}
		user := os.Getenv("OBLIMAP_ROUTEROS_USER")
		if user == "" {
			log.Printf("RouterOS: OBLIMAP_ROUTEROS_USER is empty — collector disabled")
			return
		}
		insecure := os.Getenv("OBLIMAP_ROUTEROS_INSECURE") == "1" || strings.EqualFold(os.Getenv("OBLIMAP_ROUTEROS_INSECURE"), "true")
		if u.Scheme == "http" {
			log.Printf("RouterOS: WARNING — %s uses plain HTTP: the RouterOS password travels unencrypted (use https and the www-ssl service)", u.Host)
		}
		routerOSCfg = &routerOSConfig{base: u, user: user, password: os.Getenv("OBLIMAP_ROUTEROS_PASSWORD"), insecure: insecure}
		routerOSClient = &http.Client{
			Timeout: routerOSTimeout,
			Transport: &http.Transport{
				Proxy:               nil,
				TLSClientConfig:     &tls.Config{InsecureSkipVerify: insecure, MinVersion: tls.VersionTLS12}, //nolint:gosec // opt-in for the router's self-signed certificate
				MaxIdleConns:        2,
				IdleConnTimeout:     30 * time.Second,
				TLSHandshakeTimeout: 10 * time.Second,
			},
			// Never follow a redirect away from the configured router.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
		log.Printf("RouterOS: collector enabled (%s://%s, user %s)", u.Scheme, u.Host, user)
	})
	return routerOSCfg
}

// routerOSEnabled reports whether the collector is configured.
func routerOSEnabled() bool { return loadRouterOSConfig() != nil }

func routerOSWarn(format string, args ...any) {
	routerOSWarnMu.Lock()
	defer routerOSWarnMu.Unlock()
	if time.Since(routerOSWarnAt) < routerOSWarnInterval {
		return
	}
	routerOSWarnAt = time.Now()
	log.Printf("RouterOS: "+format, args...)
}

// routerOSGet fetches one REST path (e.g. "ip/arp") into out.
func routerOSGet(ctx context.Context, cfg *routerOSConfig, path string, out any) error {
	u := *cfg.base
	rest, query, _ := strings.Cut(path, "?")
	u.Path = strings.TrimRight(u.Path, "/") + "/rest/" + rest
	u.RawQuery = query
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(cfg.user, cfg.password)
	req.Header.Set("Accept", "application/json")
	resp, err := routerOSClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, routerOSMaxBody+1))
	if err != nil {
		return err
	}
	if len(body) > routerOSMaxBody {
		return fmt.Errorf("%s: answer larger than %d MiB", path, routerOSMaxBody>>20)
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return errors.New("authentication refused (check OBLIMAP_ROUTEROS_USER / PASSWORD and the user's rest-api policy)")
	case resp.StatusCode == http.StatusNotFound:
		return fmt.Errorf("%s: not found (RouterOS v7.1+ with the www / www-ssl service is required)", path)
	case resp.StatusCode >= 300:
		return fmt.Errorf("%s: HTTP %d", path, resp.StatusCode)
	}
	return json.Unmarshal(body, out)
}

type rosARP struct {
	Address    string `json:"address"`
	MACAddress string `json:"mac-address"`
	Interface  string `json:"interface"`
	Status     string `json:"status"`
	Complete   string `json:"complete"`
	Invalid    string `json:"invalid"`
	Disabled   string `json:"disabled"`
}

type rosLease struct {
	Address          string `json:"address"`
	ActiveAddress    string `json:"active-address"`
	MACAddress       string `json:"mac-address"`
	ActiveMACAddress string `json:"active-mac-address"`
	HostName         string `json:"host-name"`
	Comment          string `json:"comment"`
	Status           string `json:"status"`
	Disabled         string `json:"disabled"`
}

type rosAddress struct {
	Address  string `json:"address"`
	Disabled string `json:"disabled"`
	Invalid  string `json:"invalid"`
}

// routerOSARPOnline: ARP states that prove the host answered recently.
// "stale" / "failed" / "incomplete" entries prove nothing (same rule as the
// probe's own ARP staleness handling): those devices count as missed.
func routerOSARPOnline(e rosARP) bool {
	if e.Invalid == "true" || e.Disabled == "true" || e.MACAddress == "" {
		return false
	}
	switch strings.ToLower(e.Status) {
	case "reachable", "delay", "probe", "permanent":
		return true
	case "":
		// RouterOS v6-style entry without a neighbour state: complete = usable.
		return e.Complete == "true"
	default:
		return false
	}
}

// RouterOSResult is what one collection returns.
type RouterOSResult struct {
	Devices []DiscoveredDevice
	Subnets []*net.IPNet
}

// collectRouterOS reads the router's tables. Only private IPv4 hosts are kept
// (like the probe's own scan). Errors are logged at most every 30 minutes.
func collectRouterOS(ctx context.Context) (*RouterOSResult, error) {
	cfg := loadRouterOSConfig()
	if cfg == nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*routerOSTimeout)
	defer cancel()

	var arp []rosARP
	if err := routerOSGet(ctx, cfg, "ip/arp", &arp); err != nil {
		routerOSWarn("ARP table unavailable: %v", err)
		return nil, err
	}
	var leases []rosLease
	if err := routerOSGet(ctx, cfg, "ip/dhcp-server/lease", &leases); err != nil {
		// No DHCP server on this router is normal: names are just missing.
		leases = nil
	}
	var addrs []rosAddress
	if err := routerOSGet(ctx, cfg, "ip/address", &addrs); err != nil {
		addrs = nil
	}
	return buildRouterOSResult(arp, leases, addrs), nil
}

// buildRouterOSResult merges the tables (pure, unit-tested).
func buildRouterOSResult(arp []rosARP, leases []rosLease, addrs []rosAddress) *RouterOSResult {
	names := map[string]string{} // by MAC (lower case), then by IP
	for _, l := range leases {
		if l.Disabled == "true" {
			continue
		}
		name := strings.TrimSpace(l.HostName)
		if name == "" {
			name = strings.TrimSpace(l.Comment)
		}
		if name == "" {
			continue
		}
		for _, mac := range []string{l.ActiveMACAddress, l.MACAddress} {
			if mac != "" {
				names[strings.ToLower(mac)] = name
			}
		}
		for _, ip := range []string{l.ActiveAddress, l.Address} {
			if ip != "" {
				names[ip] = name
			}
		}
	}

	res := &RouterOSResult{}
	seen := map[string]bool{}
	for _, e := range arp {
		if len(res.Devices) >= routerOSMaxEntries {
			break
		}
		ip := net.ParseIP(strings.TrimSpace(e.Address)).To4()
		if ip == nil || !isPrivateIPv4(ip.String()) || seen[ip.String()] {
			continue
		}
		if !routerOSARPOnline(e) {
			continue
		}
		seen[ip.String()] = true
		mac := strings.ToUpper(strings.ReplaceAll(e.MACAddress, "-", ":"))
		name := names[strings.ToLower(mac)]
		if name == "" {
			name = names[ip.String()]
		}
		res.Devices = append(res.Devices, DiscoveredDevice{IP: ip.String(), MAC: mac, Hostname: name, IsOnline: true})
	}

	for _, a := range addrs {
		if a.Disabled == "true" || a.Invalid == "true" {
			continue
		}
		ip, n, err := net.ParseCIDR(strings.TrimSpace(a.Address))
		if err != nil || ip.To4() == nil || !isPrivateIPv4(ip.String()) {
			continue
		}
		if ones, _ := n.Mask.Size(); ones < 16 || ones > 30 {
			continue // too wide to scan / point-to-point
		}
		res.Subnets = append(res.Subnets, n)
	}
	return res
}

// appendNewSubnets adds the subnets of extra that subnets does not hold yet.
func appendNewSubnets(subnets, extra []*net.IPNet) []*net.IPNet {
	seen := make(map[string]bool, len(subnets))
	for _, s := range subnets {
		seen[s.String()] = true
	}
	for _, e := range extra {
		if e != nil && !seen[e.String()] {
			seen[e.String()] = true
			subnets = append(subnets, e)
		}
	}
	return subnets
}

// routerOSDevicesIn keeps the router's hosts inside one of nets.
func routerOSDevicesIn(devs []DiscoveredDevice, nets []*net.IPNet) []DiscoveredDevice {
	var out []DiscoveredDevice
	for _, d := range devs {
		ip := net.ParseIP(d.IP)
		for _, n := range nets {
			if ip != nil && n.Contains(ip) {
				out = append(out, d)
				break
			}
		}
	}
	return out
}

// routerOSLookupIP returns the MAC the router's ARP table currently holds for
// one IP (device-check MAC binding). Only an entry in a state that proves a
// recent answer counts; any error = not verified.
func routerOSLookupIP(ip string) (string, bool) {
	cfg := loadRouterOSConfig()
	if cfg == nil || net.ParseIP(ip).To4() == nil {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var entries []rosARP
	if err := routerOSGet(ctx, cfg, "ip/arp?address="+url.QueryEscape(ip), &entries); err != nil {
		return "", false
	}
	for _, e := range entries {
		if strings.TrimSpace(e.Address) != ip || !routerOSARPOnline(e) {
			continue
		}
		mac := normalizeARPMac(strings.ReplaceAll(e.MACAddress, "-", ":"))
		if mac != "" {
			return mac, true
		}
	}
	return "", false
}

// mergeRouterOSDevices adds the router's view to the probe's own scan: a host
// the scan missed is added; a host both saw gets the router's MAC / name when
// the scan had none, and counts as online.
func mergeRouterOSDevices(scanned []DiscoveredDevice, ros []DiscoveredDevice) []DiscoveredDevice {
	index := make(map[string]int, len(scanned))
	for i, d := range scanned {
		index[d.IP] = i
	}
	for _, r := range ros {
		if i, ok := index[r.IP]; ok {
			if scanned[i].MAC == "" {
				scanned[i].MAC = r.MAC
			}
			if scanned[i].Hostname == "" {
				scanned[i].Hostname = r.Hostname
			}
			scanned[i].IsOnline = true
			continue
		}
		index[r.IP] = len(scanned)
		scanned = append(scanned, r)
	}
	return scanned
}
