import { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { useAnonymize } from '@/utils/anonymize';
import { csvRow } from '@/utils/csv';
import { siteApi } from '@/api/site.api';
import { useConfirm } from '@/components/common/ConfirmDialog';
import type { SiteItem, NetworkFlow, FlowPeriod } from '@oblimap/shared';

// ─── Props ───────────────────────────────────────────────────────────────────

interface NetworkStarmapProps {
  siteId: number;
  items: SiteItem[];
  /** The map's tab is shown: the animation only runs while it is (and the page is visible). */
  active: boolean;
  /** Write permission on the site: clearing the captured flows takes it (server: requireSiteWrite). */
  canWrite: boolean;
}

// ─── Well-known ports → service name ─────────────────────────────────────────

const WELL_KNOWN_PORTS: Record<number, string> = {
  20: 'FTP-DATA', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP',
  53: 'DNS', 67: 'DHCP', 68: 'DHCP', 80: 'HTTP', 88: 'Kerberos',
  110: 'POP3', 111: 'RPC', 123: 'NTP', 135: 'RPC', 137: 'NetBIOS',
  138: 'NetBIOS', 139: 'NetBIOS', 143: 'IMAP', 161: 'SNMP', 162: 'SNMP-Trap',
  389: 'LDAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 514: 'Syslog',
  587: 'SMTP-TLS', 636: 'LDAPS', 993: 'IMAPS', 995: 'POP3S',
  1433: 'MSSQL', 1521: 'Oracle', 2049: 'NFS', 3000: 'Dev/Grafana',
  3001: 'Dev', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL',
  5060: 'SIP', 5061: 'SIP-TLS', 5222: 'XMPP',
  5900: 'VNC', 5985: 'WinRM', 5986: 'WinRM-S', 6379: 'Redis',
  6443: 'K8s-API', 8080: 'HTTP-Alt', 8443: 'HTTPS-Alt', 8883: 'MQTT-S',
  9090: 'Prometheus', 9200: 'Elasticsearch', 9300: 'ES-Transport',
  27017: 'MongoDB', 1883: 'MQTT', 11211: 'Memcached',
};

function portLabel(port: number): string {
  const name = WELL_KNOWN_PORTS[port];
  return name ? `${port}/${name}` : String(port);
}

// ─── Device type colors ──────────────────────────────────────────────────────

const DEVICE_COLORS: Record<string, string> = {
  router:      '#00cfff',
  firewall:    '#F5A623',
  server:      '#7F77DD',
  switch:      '#5DCAA5',
  printer:     '#E8965A',
  iot:         '#E24B4A',
  camera:      '#D65DB1',
  workstation: '#48A9F8',
  phone:       '#6FDFDF',
  gsm:         '#3EC1D3',
  laptop:      '#4F9DDE',
  vm:          '#9B72CF',
  ap:          '#78D9A4',
  nas:         '#D4A054',
  counter:     '#8F8F8F',
  unknown:     '#6a8fad',
};

const LEGEND_TYPES = ['router', 'server', 'switch', 'firewall', 'printer', 'workstation'] as const;

// ─── Graph types ─────────────────────────────────────────────────────────────

interface GNode {
  id: string;
  label: string;
  deviceType: string;
  vendor: string | null;
  status: string;
  isProbe: boolean;
  ips: string[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  connections: number;
  ports: number[];
}

interface GLink {
  source: string;
  target: string;
  ports: number[];
  weight: number; // connection_count
}

interface Particle {
  link: GLink;
  t: number;
  speed: number;
}

// ─── Period options ──────────────────────────────────────────────────────────

const PERIODS: { id: FlowPeriod; labelKey: string }[] = [
  { id: '1h',  labelKey: 'networkMap.period1h' },
  { id: '24h', labelKey: 'networkMap.period24h' },
  { id: '30d', labelKey: 'networkMap.period30d' },
  { id: '1y',  labelKey: 'networkMap.period1y' },
];

// ─── Force simulation ────────────────────────────────────────────────────────

function runForceLayout(nodes: GNode[], links: GLink[], width: number, height: number) {
  const nodeMap = new Map<string, GNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  // Seed positions in a circle if not already set
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.35;
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    n.x = cx + radius * Math.cos(angle) + (Math.random() - 0.5) * 20;
    n.y = cy + radius * Math.sin(angle) + (Math.random() - 0.5) * 20;
    n.vx = 0;
    n.vy = 0;
  });

  const iterations = 200;
  const repulsion = 4000;
  const attraction = 0.005;
  const damping = 0.9;
  const padding = 40;

  for (let iter = 0; iter < iterations; iter++) {
    const decay = 1 - iter / iterations;

    // Repulsion (Coulomb)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) dist = 1;
        const force = (repulsion * decay) / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    // Attraction (Hooke)
    for (const link of links) {
      const s = nodeMap.get(link.source);
      const t = nodeMap.get(link.target);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const force = attraction * dist * decay;
      const fx = (dx / (dist || 1)) * force;
      const fy = (dy / (dist || 1)) * force;
      s.vx += fx;
      s.vy += fy;
      t.vx -= fx;
      t.vy -= fy;
    }

    // Center gravity
    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.001 * decay;
      n.vy += (cy - n.y) * 0.001 * decay;
    }

    // Apply velocity + damping
    for (const n of nodes) {
      n.vx *= damping;
      n.vy *= damping;
      n.x += n.vx;
      n.y += n.vy;
      // Keep in bounds
      n.x = Math.max(padding, Math.min(width - padding, n.x));
      n.y = Math.max(padding, Math.min(height - padding, n.y));
    }
  }
}

// ─── Build graph from flows ──────────────────────────────────────────────────

function buildGraph(flows: NetworkFlow[], items: SiteItem[]): { nodes: GNode[]; links: GLink[] } {
  const itemByIp = new Map<string, SiteItem>();
  for (const item of items) itemByIp.set(item.ip, item);

  // Build probe grouping maps: IP → probeId, probeId → primary IP
  const ipToProbeId = new Map<string, number>();
  const probeIdToPrimaryIp = new Map<number, string>();
  const probeIdIps = new Map<number, string[]>();
  for (const item of items) {
    if (item.isProbe && item.probeId) {
      ipToProbeId.set(item.ip, item.probeId);
      if (!probeIdToPrimaryIp.has(item.probeId)) {
        probeIdToPrimaryIp.set(item.probeId, item.ip);
      }
      if (!probeIdIps.has(item.probeId)) probeIdIps.set(item.probeId, []);
      const ips = probeIdIps.get(item.probeId)!;
      if (!ips.includes(item.ip)) ips.push(item.ip);
    }
  }

  // Resolve an IP to its canonical node ID (merging probe IPs)
  function canonicalIp(ip: string): string {
    const probeId = ipToProbeId.get(ip);
    if (probeId != null) return probeIdToPrimaryIp.get(probeId) ?? ip;
    return ip;
  }

  const nodeSet = new Map<string, GNode>();
  const linkMap = new Map<string, GLink>();

  function getOrCreateNode(ip: string): GNode {
    const canonical = canonicalIp(ip);
    let node = nodeSet.get(canonical);
    if (!node) {
      const item = itemByIp.get(canonical);
      const probeId = ipToProbeId.get(canonical);
      const allIps = probeId != null ? (probeIdIps.get(probeId) ?? [canonical]) : [canonical];
      node = {
        id: canonical,
        label: item?.customName ?? item?.hostname ?? canonical,
        deviceType: item?.deviceType ?? 'unknown',
        vendor: item?.vendor ?? null,
        status: item?.status ?? 'unknown',
        isProbe: item?.isProbe === true,
        ips: allIps,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        r: 10,
        connections: 0,
        ports: [],
      };
      nodeSet.set(canonical, node);
    }
    // Accumulate the original IP if not already tracked (for non-primary probe IPs)
    if (!node.ips.includes(ip)) node.ips.push(ip);
    // Ensure isProbe is set if any contributing IP is a probe
    if (itemByIp.get(ip)?.isProbe) node.isProbe = true;
    return node;
  }

  for (const flow of flows) {
    const sNode = getOrCreateNode(flow.sourceIp);
    const tNode = getOrCreateNode(flow.destIp);
    sNode.connections += flow.connectionCount;
    tNode.connections += flow.connectionCount;
    if (!tNode.ports.includes(flow.destPort)) tNode.ports.push(flow.destPort);

    const linkKey = [sNode.id, tNode.id].sort().join('->');
    const existing = linkMap.get(linkKey);
    if (existing) {
      existing.weight += flow.connectionCount;
      if (!existing.ports.includes(flow.destPort)) existing.ports.push(flow.destPort);
    } else {
      linkMap.set(linkKey, {
        source: sNode.id,
        target: tNode.id,
        ports: [flow.destPort],
        weight: flow.connectionCount,
      });
    }
  }

  const nodes = [...nodeSet.values()];
  // Scale node radius by connection count
  const maxConn = Math.max(1, ...nodes.map((n) => n.connections));
  for (const n of nodes) {
    n.r = 8 + 10 * (n.connections / maxConn);
  }

  return { nodes, links: [...linkMap.values()] };
}

/** Node ids + link endpoints: what the force layout depends on. */
function topologySignature(nodes: GNode[], links: GLink[]): string {
  const n = nodes.map((x) => x.id).sort().join(',');
  const l = links.map((x) => `${x.source}->${x.target}`).sort().join(',');
  return `${n}|${l}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function NetworkStarmap({ siteId, items, active, canWrite }: NetworkStarmapProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { anonymize } = useAnonymize();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef(0);
  // Latest `active` for the window listeners (no hover tracking while hidden).
  const activeRef = useRef(active);
  activeRef.current = active;

  const [period, setPeriod] = useState<FlowPeriod>('24h');
  const [flows, setFlows] = useState<NetworkFlow[]>([]);
  const [loading, setLoading] = useState(true);

  // Camera state refs (avoid re-render on pan/zoom)
  const camRef = useRef({ x: 0, y: 0, zoom: 1 });
  const dragRef = useRef<{ dragging: boolean; startX: number; startY: number; camStartX: number; camStartY: number }>({
    dragging: false, startX: 0, startY: 0, camStartX: 0, camStartY: 0,
  });
  const hoverRef = useRef<GNode | null>(null);
  const [tooltip, setTooltip] = useState<{ node: GNode; x: number; y: number } | null>(null);

  // Stable graph data refs
  const graphRef = useRef<{ nodes: GNode[]; links: GLink[]; particles: Particle[]; stars: { x: number; y: number; s: number; b: number }[] }>({
    nodes: [], links: [], particles: [], stars: [],
  });
  const sizeRef = useRef({ w: 0, h: 0 });
  // Topology of the laid-out graph (see topologySignature); null = none yet.
  const topoSigRef = useRef<string | null>(null);

  // ─── Fetch flows ─────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    siteApi.listFlows(siteId, period).then((res) => {
      if (!cancelled) setFlows(res.flows);
    }).catch(() => {
      if (!cancelled) setFlows([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [siteId, period]);

  // ─── Export CSV ──────────────────────────────────────────────────────────

  const exportCSV = useCallback(() => {
    if (flows.length === 0) return;

    // Build a map: server IP → { services it exposes (dest ports where it's the dest), clients that connect }
    const itemMap = new Map<string, SiteItem>();
    for (const item of items) itemMap.set(item.ip, item);

    const servers = new Map<string, { ports: Map<number, Set<string>>; outbound: Map<string, Set<number>> }>();

    const ensureServer = (ip: string) => {
      if (!servers.has(ip)) servers.set(ip, { ports: new Map(), outbound: new Map() });
      return servers.get(ip)!;
    };

    for (const f of flows) {
      // dest is the server exposing the service
      const srv = ensureServer(f.destIp);
      if (!srv.ports.has(f.destPort)) srv.ports.set(f.destPort, new Set());
      srv.ports.get(f.destPort)!.add(f.sourceIp);

      // source has an outbound connection
      const src = ensureServer(f.sourceIp);
      if (!src.outbound.has(f.destIp)) src.outbound.set(f.destIp, new Set());
      src.outbound.get(f.destIp)!.add(f.destPort);
    }

    // Every row goes through csvRow: hostnames and process names come from
    // probes / users and must not break columns or be evaluated as formulas.
    const lines: string[] = [csvRow([
      'Server IP', 'Hostname', 'Device Type', 'Direction', 'Port',
      'Service', 'Remote IP', 'Remote Hostname', 'Process',
    ])];

    for (const [ip, data] of [...servers.entries()].sort()) {
      const item = itemMap.get(ip);
      const hostname = item?.customName || item?.hostname || '';
      const dtype = item?.deviceType || 'unknown';

      // Inbound services (remote → this server)
      for (const [port, clients] of [...data.ports.entries()].sort((a, b) => a[0] - b[0])) {
        const svc = WELL_KNOWN_PORTS[port] || '';
        for (const clientIp of [...clients].sort()) {
          const ci = itemMap.get(clientIp);
          const ch = ci?.customName || ci?.hostname || '';
          const proc = flows.find(f => f.destIp === ip && f.destPort === port && f.sourceIp === clientIp)?.sourceProcess || '';
          lines.push(csvRow([ip, hostname, dtype, `INBOUND (${clientIp} → ${ip}:${port})`, port, svc, clientIp, ch, proc]));
        }
      }

      // Outbound connections (this server → remote)
      for (const [destIp, ports] of [...data.outbound.entries()].sort()) {
        for (const port of [...ports].sort()) {
          const svc = WELL_KNOWN_PORTS[port] || '';
          const di = itemMap.get(destIp);
          const dh = di?.customName || di?.hostname || '';
          const proc = flows.find(f => f.sourceIp === ip && f.destIp === destIp && f.destPort === port)?.sourceProcess || '';
          lines.push(csvRow([ip, hostname, dtype, `OUTBOUND (${ip} → ${destIp}:${port})`, port, svc, destIp, dh, proc]));
        }
      }
    }

    // BOM so Excel decodes UTF-8 (→ in Direction, non-ASCII hostnames)
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `network-flows-${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [flows, items, period]);

  // ─── Build graph when flows change ───────────────────────────────────────

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    sizeRef.current = { w, h };

    const { nodes, links } = buildGraph(flows, items);

    // Items are reloaded on every probe push (SITE_UPDATED): when the
    // topology (node ids + links) did not change, update the existing nodes /
    // links in place and keep the layout, the particles and the camera, so a
    // zoomed / panned view survives and the hovered node stays current.
    const signature = topologySignature(nodes, links);
    const prev = graphRef.current;
    if (signature === topoSigRef.current && prev.nodes.length === nodes.length && prev.links.length === links.length) {
      const fresh = new Map(nodes.map((n) => [n.id, n]));
      for (const n of prev.nodes) {
        const u = fresh.get(n.id);
        if (!u) continue;
        n.label = u.label;
        n.deviceType = u.deviceType;
        n.vendor = u.vendor;
        n.status = u.status;
        n.isProbe = u.isProbe;
        n.ips = u.ips;
        n.r = u.r;
        n.connections = u.connections;
        n.ports = u.ports;
      }
      const freshLinks = new Map(links.map((l) => [`${l.source}->${l.target}`, l]));
      for (const l of prev.links) {
        const u = freshLinks.get(`${l.source}->${l.target}`);
        if (!u) continue;
        l.weight = u.weight;
        l.ports = u.ports;
      }
      // Re-render an open tooltip with the updated node data.
      setTooltip((tt) => (tt ? { ...tt } : tt));
      return;
    }
    topoSigRef.current = signature;
    hoverRef.current = null;
    setTooltip(null);

    runForceLayout(nodes, links, w, h);

    // Generate particles along links
    const particles: Particle[] = [];
    const maxWeight = Math.max(1, ...links.map((l) => l.weight));
    for (const link of links) {
      const count = Math.max(1, Math.floor((link.weight / maxWeight) * 4) + 1);
      for (let i = 0; i < count; i++) {
        particles.push({
          link,
          t: Math.random(),
          speed: 0.001 + Math.random() * 0.003,
        });
      }
    }

    // Stars
    const stars: { x: number; y: number; s: number; b: number }[] = [];
    for (let i = 0; i < 300; i++) {
      stars.push({ x: Math.random() * w, y: Math.random() * h, s: Math.random() * 1.2 + 0.3, b: Math.random() });
    }

    graphRef.current = { nodes, links, particles, stars };
    // Reset camera
    camRef.current = { x: 0, y: 0, zoom: 1 };
  }, [flows, items]);

  // ─── Canvas rendering ────────────────────────────────────────────────────

  const tx = useCallback((x: number) => {
    const cam = camRef.current;
    const { w } = sizeRef.current;
    return (x + cam.x) * cam.zoom + w / 2 * (1 - cam.zoom);
  }, []);

  const ty = useCallback((y: number) => {
    const cam = camRef.current;
    const { h } = sizeRef.current;
    return (y + cam.y) * cam.zoom + h / 2 * (1 - cam.zoom);
  }, []);

  const getColor = useCallback((n: GNode) => {
    if (n.status === 'offline') return '#E24B4A';
    return DEVICE_COLORS[n.deviceType] ?? DEVICE_COLORS.unknown;
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { w, h } = sizeRef.current;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { nodes, links, particles, stars } = graphRef.current;
    const cam = camRef.current;
    const time = ++timeRef.current;

    // Background
    ctx.fillStyle = '#06090f';
    ctx.fillRect(0, 0, w, h);

    // Nebula gradients
    const nebGrd = ctx.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.4, w * 0.5);
    nebGrd.addColorStop(0, 'rgba(20,40,70,0.15)');
    nebGrd.addColorStop(0.5, 'rgba(15,25,50,0.08)');
    nebGrd.addColorStop(1, 'transparent');
    ctx.fillStyle = nebGrd;
    ctx.fillRect(0, 0, w, h);

    const nebGrd2 = ctx.createRadialGradient(w * 0.75, h * 0.6, 0, w * 0.75, h * 0.6, w * 0.35);
    nebGrd2.addColorStop(0, 'rgba(60,30,20,0.1)');
    nebGrd2.addColorStop(1, 'transparent');
    ctx.fillStyle = nebGrd2;
    ctx.fillRect(0, 0, w, h);

    // Stars
    for (const s of stars) {
      const flicker = 0.6 + 0.4 * Math.sin(time * 0.02 + s.b * 100);
      ctx.fillStyle = `rgba(180,200,230,${flicker * 0.5})`;
      ctx.fillRect(s.x, s.y, s.s, s.s);
    }

    // Build node map for link lookups
    const nodeMap = new Map<string, GNode>();
    for (const n of nodes) nodeMap.set(n.id, n);

    // Links
    for (const link of links) {
      const s = nodeMap.get(link.source);
      const t = nodeMap.get(link.target);
      if (!s || !t) continue;
      const sx = tx(s.x), sy = ty(s.y);
      const ex = tx(t.x), ey = ty(t.y);
      const alpha = 0.12 + Math.min(link.weight / 50, 0.3);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = `rgba(60,140,200,${alpha})`;
      ctx.lineWidth = Math.min(0.5 + link.weight / 20, 3) * cam.zoom;
      ctx.stroke();

      // Port labels on links
      if (cam.zoom > 0.7 && link.ports.length > 0) {
        const mx = (sx + ex) / 2;
        const my = (sy + ey) / 2;
        ctx.font = `${Math.round(9 * cam.zoom)}px monospace`;
        ctx.fillStyle = 'rgba(90,138,181,0.6)';
        ctx.textAlign = 'center';
        ctx.fillText(link.ports.slice(0, 3).map(portLabel).join(', '), mx, my - 4 * cam.zoom);
      }
    }

    // Particles
    for (const p of particles) {
      p.t += p.speed;
      if (p.t > 1) p.t -= 1;
      const s = nodeMap.get(p.link.source);
      const t = nodeMap.get(p.link.target);
      if (!s || !t) continue;
      const px = tx(s.x + (t.x - s.x) * p.t);
      const py = ty(s.y + (t.y - s.y) * p.t);
      ctx.fillStyle = 'rgba(0,200,255,0.55)';
      ctx.beginPath();
      ctx.arc(px, py, 1.2 * cam.zoom, 0, Math.PI * 2);
      ctx.fill();
    }

    // Nodes
    const hovered = hoverRef.current;
    for (const n of nodes) {
      const sx = tx(n.x), sy = ty(n.y);
      const sr = n.r * cam.zoom;
      const col = getColor(n);

      // Offline pulse
      if (n.status === 'offline') {
        const pulse = 0.3 + 0.3 * Math.sin(time * 0.08);
        ctx.shadowBlur = sr * 2;
        ctx.shadowColor = col;
        ctx.fillStyle = `rgba(226,75,74,${pulse})`;
        ctx.beginPath();
        ctx.arc(sx, sy, sr * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Gradient fill
      const grd = ctx.createRadialGradient(sx - sr * 0.25, sy - sr * 0.25, sr * 0.1, sx, sy, sr);
      grd.addColorStop(0, 'rgba(255,255,255,0.25)');
      grd.addColorStop(0.4, col);
      grd.addColorStop(1, hexToRgba(col, 0.3));
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();

      // Inner glow
      ctx.shadowBlur = sr * 1.5;
      ctx.shadowColor = col;
      ctx.beginPath();
      ctx.arc(sx, sy, sr * 0.6, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Probe dashed ring
      if (n.isProbe) {
        ctx.save();
        ctx.strokeStyle = '#8dc63f';
        ctx.lineWidth = 1.5 * cam.zoom;
        ctx.setLineDash([4 * cam.zoom, 3 * cam.zoom]);
        ctx.beginPath();
        ctx.arc(sx, sy, sr + 5 * cam.zoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Hover ring
      if (n === hovered) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, sr + (n.isProbe ? 9 : 4), 0, Math.PI * 2);
        ctx.stroke();
      }

      // Label
      if (cam.zoom > 0.7) {
        ctx.font = `500 ${Math.round(10 * cam.zoom)}px system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(200,220,240,0.8)';
        ctx.textAlign = 'center';
        ctx.fillText(anonymize(n.label, 'hostname'), sx, sy + sr + 12 * cam.zoom);
      }
    }
  }, [tx, ty, getColor, anonymize]);

  // ─── Animation loop: only while the tab is active and the page visible ────

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (raf === 0 && !document.hidden) raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, draw]);

  // Leaving the tab drops the hover (no tooltip left behind on return).
  useEffect(() => {
    if (active) return;
    hoverRef.current = null;
    setTooltip(null);
  }, [active]);

  // ─── Lifecycle: input listeners ──────────────────────────────────────────

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const handleResize = () => {
      const rect = wrap.getBoundingClientRect();
      sizeRef.current = { w: rect.width, h: rect.height };
      // Regenerate stars for new size
      const stars: { x: number; y: number; s: number; b: number }[] = [];
      for (let i = 0; i < 300; i++) {
        stars.push({ x: Math.random() * rect.width, y: Math.random() * rect.height, s: Math.random() * 1.2 + 0.3, b: Math.random() });
      }
      graphRef.current.stars = stars;
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = e.deltaY > 0 ? 0.92 : 1.08;
      camRef.current.zoom = Math.max(0.4, Math.min(3, camRef.current.zoom * d));
    };

    const handleMouseDown = (e: MouseEvent) => {
      dragRef.current = {
        dragging: true,
        startX: e.clientX,
        startY: e.clientY,
        camStartX: camRef.current.x,
        camStartY: camRef.current.y,
      };
    };

    const handleMouseUp = () => {
      dragRef.current.dragging = false;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (dragRef.current.dragging) {
        camRef.current.x = dragRef.current.camStartX + (e.clientX - dragRef.current.startX) / camRef.current.zoom;
        camRef.current.y = dragRef.current.camStartY + (e.clientY - dragRef.current.startY) / camRef.current.zoom;
        canvas.style.cursor = 'grabbing';
        return;
      }
      // Hidden tab: nothing to hover (and no re-render per mouse move).
      if (!activeRef.current) return;

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Hit test
      const { nodes } = graphRef.current;
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      let found: GNode | null = null;
      for (const n of nodes) {
        const sx = (n.x + cam.x) * cam.zoom + w / 2 * (1 - cam.zoom);
        const sy = (n.y + cam.y) * cam.zoom + h / 2 * (1 - cam.zoom);
        const sr = n.r * cam.zoom;
        if (Math.hypot(mx - sx, my - sy) < sr + 6) {
          found = n;
          break;
        }
      }
      hoverRef.current = found;
      canvas.style.cursor = found ? 'pointer' : 'grab';
      // Tooltip follows the hovered node and the pointer; no update while
      // nothing is hovered and nothing was.
      setTooltip((prev) => (found ? { node: found, x: mx, y: my } : prev === null ? prev : null));
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('resize', handleResize);

    // Initial size
    handleResize();

    return () => {
      canvas.removeEventListener('wheel', handleWheel);
      canvas.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // ─── Clear captured flows ────────────────────────────────────────────────

  const clearFlows = useCallback(async () => {
    if (!(await confirm({ message: t('networkMap.confirmClear'), danger: true, confirmLabel: t('networkMap.clear') }))) return;
    try {
      await siteApi.clearFlows(siteId);
      setFlows([]);
    } catch {
      toast.error(t('networkMap.clearFailed', 'Failed to clear the network flows'));
    }
  }, [siteId, t, confirm]);

  // ─── Render ──────────────────────────────────────────────────────────────

  const { nodes, links } = graphRef.current;
  const hasFlows = flows.length > 0;

  // Flows come from the probe host's own sockets (ss / netstat on the probe
  // machine), not from a LAN traffic source: said under the map and in the
  // empty state so a sparse map does not read as broken.
  const scopeNote = t('networkMap.scopeNote', 'Flows are the TCP connections seen from the probe host itself, not traffic between other devices.');

  return (
    <div>
      <div
        ref={wrapRef}
        className="relative w-full rounded-xl overflow-hidden"
        style={{ height: 620, background: '#06090f' }}
      >
        <canvas ref={canvasRef} className="block w-full h-full" />

        {/* Period selector */}
        <div className="absolute top-3.5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 bg-[rgba(8,14,24,0.85)] border border-[rgba(90,138,181,0.25)] rounded-lg p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              onClick={() => setPeriod(p.id)}
              className={`px-3 py-1 text-xs font-mono rounded-md transition-colors ${
                period === p.id
                  ? 'bg-[rgba(90,138,181,0.25)] text-[#c0daf0]'
                  : 'text-[#5a8ab5] hover:text-[#a0c4e0]'
              }`}
            >
              {t(p.labelKey)}
            </button>
          ))}
        </div>

        {/* HUD top-left */}
        <div className="absolute top-3.5 left-4 flex items-center gap-3">
          <span className="font-mono text-[11px] text-[#5a8ab5] bg-[rgba(90,138,181,0.1)] border border-[rgba(90,138,181,0.25)] rounded px-2 py-0.5">
            {t('networkMap.title')}
          </span>
        </div>

        {/* HUD top-right */}
        <div className="absolute top-3.5 right-4 flex gap-4">
          <div className="text-right">
            <div className="font-sans text-[10px] text-[#5a8ab5] uppercase tracking-wider">{t('networkMap.nodes')}</div>
            <div className="font-mono text-sm font-medium text-[#c0daf0]">{nodes.length}</div>
          </div>
          <div className="text-right">
            <div className="font-sans text-[10px] text-[#5a8ab5] uppercase tracking-wider">{t('networkMap.links')}</div>
            <div className="font-mono text-sm font-medium text-[#c0daf0]">{links.length}</div>
          </div>
        </div>

        {/* HUD bottom */}
        <div className="absolute bottom-3.5 left-4 right-4 flex justify-between items-end">
          <div className="flex gap-3.5">
            {LEGEND_TYPES.map((dt) => (
              <div key={dt} className="flex items-center gap-1.5 text-[11px] text-[#6a8fad]">
                <span
                  className="w-2 h-2 rounded-full inline-block"
                  style={{ background: DEVICE_COLORS[dt] }}
                />
                {t(`deviceTypes.${dt}`)}
              </div>
            ))}
            <div className="flex items-center gap-1.5 text-[11px] text-[#6a8fad]">
              <span
                className="w-2.5 h-2.5 rounded-full inline-block"
                style={{ border: '1.5px dashed #8dc63f', background: 'transparent' }}
              />
              {t('networkMap.probe', 'Probe')}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {flows.length > 0 && (
              <button
                onClick={exportCSV}
                className="z-10 font-mono text-[11px] text-[#5a8ab5] hover:text-[#c0daf0] transition-colors"
              >
                {t('networkMap.csv', 'CSV')}
              </button>
            )}
            {canWrite && (
              <button
                onClick={() => void clearFlows()}
                className="z-10 font-mono text-[11px] text-[#5a4040] hover:text-[#E24B4A] transition-colors"
              >
                {t('networkMap.clear')}
              </button>
            )}
            <span className="font-mono text-[11px] text-[#3a6080]">
              {t('networkMap.zoomHint')}
            </span>
          </div>
        </div>

        {/* Tooltip */}
        {tooltip && (
          <div
            className="absolute pointer-events-none z-10"
            style={{
              left: tooltip.x + 16 + 180 > sizeRef.current.w ? tooltip.x - 180 : tooltip.x + 16,
              top: tooltip.y - 10,
            }}
          >
            <div className="bg-[rgba(8,14,24,0.92)] border border-[rgba(90,138,181,0.35)] rounded-md px-3.5 py-2.5 min-w-[170px]">
              <div className="text-[13px] font-medium text-[#d4e0ed] mb-1 flex items-center gap-2">
                {anonymize(tooltip.node.label, 'hostname')}
                {tooltip.node.isProbe && (
                  <span className="text-[9px] font-semibold uppercase tracking-wider text-[#8dc63f] bg-[rgba(141,198,63,0.12)] border border-[rgba(141,198,63,0.3)] rounded px-1.5 py-px">{t('networkMap.probe', 'Probe')}</span>
                )}
              </div>
              <div className="text-[11px] text-[#F5A623] mb-1.5">
                {t(`deviceTypes.${tooltip.node.deviceType}`)}
              </div>
              <div className="flex justify-between gap-5 text-[11px] text-[#6a8fad] mb-0.5">
                <span>{tooltip.node.ips.length > 1 ? t('networkMap.ips', 'IPs') : t('networkMap.ip', 'IP')}</span>
                <span className="text-[#a0c4e0] font-mono">{tooltip.node.ips.map(ip => anonymize(ip, 'ip')).join(', ')}</span>
              </div>
              {tooltip.node.vendor && (
                <div className="flex justify-between gap-5 text-[11px] text-[#6a8fad] mb-0.5">
                  <span>{t('networkMap.vendor', 'Vendor')}</span>
                  <span className="text-[#a0c4e0] font-mono">{tooltip.node.vendor}</span>
                </div>
              )}
              <div className="flex justify-between gap-5 text-[11px] text-[#6a8fad] mb-0.5">
                <span>{t('networkMap.connections')}</span>
                <span className="text-[#a0c4e0] font-mono">{tooltip.node.connections}</span>
              </div>
              {tooltip.node.ports.length > 0 && (
                <div className="flex justify-between gap-5 text-[11px] text-[#6a8fad]">
                  <span>{t('networkMap.ports', 'Ports')}</span>
                  <span className="text-[#a0c4e0] font-mono">{tooltip.node.ports.slice(0, 6).map(portLabel).join(', ')}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#06090f]/70 pointer-events-none">
            <div className="animate-spin w-6 h-6 border-2 border-[#5a8ab5] border-t-transparent rounded-full" />
          </div>
        )}

        {/* Empty state */}
        {!loading && !hasFlows && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8 pointer-events-none">
            <div className="text-[#5a8ab5] mb-3">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 12h8M12 8v8" />
              </svg>
            </div>
            <p className="text-[#c0daf0] font-medium text-sm mb-1">{t('networkMap.noFlows')}</p>
            <p className="text-[#5a8ab5] text-xs max-w-sm">{t('networkMap.noFlowsDesc')}</p>
            <p className="text-[#5a8ab5] text-xs max-w-sm mt-2">{scopeNote}</p>
          </div>
        )}
      </div>
      {hasFlows && <p className="mt-2 text-xs text-text-muted">{scopeNote}</p>}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
