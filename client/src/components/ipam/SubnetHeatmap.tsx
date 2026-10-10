/**
 * SubnetHeatmap — visual IP address space of a site, one section per subnet.
 *
 * Sections are the site's subnets (GET /sites/:id/subnets: manual subnets and
 * the prefixes its probes scan); addresses outside every site subnet fall
 * back to one section per /24. Each section is drawn as 16 × 16 tiles of a
 * /24 (256 addresses):
 *   - /24 and narrower: one tile, the addresses outside the subnet greyed out;
 *   - /23 to /20: every /24 of the subnet under one header (a /24 that is a
 *     site subnet of its own is drawn in its own section instead);
 *   - wider than /20: only the /24s holding a used address.
 * The header shows the CIDR, name / VLAN and the utilisation (used / usable
 * host addresses, devices and reservations).
 *
 * Cell colours:
 *   online            → emerald
 *   offline           → red
 *   reserved (status) → blue
 *   unknown           → zinc
 *   reservation free  → blue (light)
 *   held by its owner → teal
 *   owner offline     → amber
 *   conflict          → orange
 *   empty             → bg-bg-tertiary (muted)
 *
 * onCellClick(ip, target): a used IP gives its device, a reserved IP its
 * reservation, a free host address of the subnet null (only when `canReserve`).
 */

import { useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { SiteItem, IpReservation } from '@oblimap/shared';
import { clsx } from 'clsx';
import { useAnonymize } from '@/utils/anonymize';
import { reservationStateLabel, reservationStateOf } from '@/utils/exportSite';
import {
  countUsedHosts, hostRange, intToIpv4, ipv4ToInt, longestMatch, parseSiteSubnets, subnetSize,
  usableHosts, useSiteSubnets, utilisationTone,
  type Ipv4Net, type SiteSubnet,
} from '@/api/siteSubnets.api';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Widest subnet drawn with all its /24 tiles (wider: only the used /24s). */
const FULL_TILES_MIN_PREFIX = 20;
const TILE_SIZE = 256;

function timeOf(ts: string | null | undefined): number {
  const n = ts ? new Date(ts).getTime() : 0;
  return Number.isNaN(n) ? 0 : n;
}

/** The item shown for an IP held by several rows: online first, then the latest seen. */
function betterItem(a: SiteItem, b: SiteItem): SiteItem {
  if ((a.status === 'online') !== (b.status === 'online')) return a.status === 'online' ? a : b;
  return timeOf(a.lastSeenAt) >= timeOf(b.lastSeenAt) ? a : b;
}

function tileBaseOf(n: number): number {
  return n - (n % TILE_SIZE);
}

// ── types ─────────────────────────────────────────────────────────────────────

export type HeatmapTarget =
  | { kind: 'item'; item: SiteItem }
  | { kind: 'reservation'; reservation: IpReservation }
  | null;

type CellKind =
  | 'online' | 'offline' | 'reserved' | 'unknown'
  | 'resFree' | 'held' | 'ownerOffline' | 'conflict';

interface CellData {
  ip: string;
  kind: CellKind;
  item: SiteItem | null;
  reservation: IpReservation | null;
}

/** A /24 block of a section. */
interface Tile {
  /** Network address of the /24, unsigned 32-bit. */
  base: number;
  cells: (CellData | null)[];   // 256 entries, index = host octet
}

interface Section {
  key: string;
  net: Ipv4Net;
  /** The site subnet (null: /24 fallback for addresses outside every site subnet). */
  subnet: SiteSubnet | null;
  tiles: Tile[];
  used: number;
  usable: number;
  /** Wider than /20: the /24s without a used address are not drawn. */
  onlyUsedTiles: boolean;
  /** /24s of the subnet drawn in the section of a more specific site subnet. */
  delegatedTiles: number;
}

function cellKind(item: SiteItem | null, reservation: IpReservation | null): CellKind {
  if (item?.hasReservationConflict) return 'conflict';
  if (reservation) {
    const state = reservationStateOf(reservation);
    if (state === 'conflict') return 'conflict';
    if (state === 'held') return 'held';
    if (state === 'owner_offline') return 'ownerOffline';
    if (!item) return 'resFree';
  }
  switch (item?.status) {
    case 'online': return 'online';
    case 'offline': return 'offline';
    case 'reserved': return 'reserved';
    default: return 'unknown';
  }
}

/**
 * The sections of the heatmap: one per site subnet (sorted by address), then
 * /24 fallbacks for the used addresses no site subnet holds. Pure.
 */
function buildSections(
  cellByInt: ReadonlyMap<number, CellData>,
  subnets: readonly SiteSubnet[] | null,
): Section[] {
  const parsed = parseSiteSubnets(subnets);
  const usedInts = [...cellByInt.keys()];
  const usedIps = [...cellByInt.values()].map((c) => c.ip);

  const tileOf = (base: number): Tile => {
    const cells: (CellData | null)[] = new Array(TILE_SIZE).fill(null) as null[];
    for (let i = 0; i < TILE_SIZE; i++) cells[i] = cellByInt.get(base + i) ?? null;
    return { base, cells };
  };

  const sections: Section[] = [];
  for (const p of parsed) {
    const { net, subnet } = p;
    const size = subnetSize(net.prefix);
    const tiles: Tile[] = [];
    let delegatedTiles = 0;
    const onlyUsedTiles = net.prefix < FULL_TILES_MIN_PREFIX;
    if (net.prefix >= 24) {
      tiles.push(tileOf(tileBaseOf(net.base)));
    } else {
      // /24 blocks drawn by a more specific site subnet of /24 or wider.
      const delegated = (tileBase: number) => parsed.some((q) =>
        q !== p && q.net.prefix > net.prefix && q.net.prefix <= 24
        && tileBase >= q.net.base && tileBase < q.net.base + subnetSize(q.net.prefix));
      let bases: number[];
      if (onlyUsedTiles) {
        // Only the used /24s whose addresses this subnet is the longest match of.
        const set = new Set<number>();
        for (const n of usedInts) {
          if (n < net.base || n >= net.base + size) continue;
          const m = longestMatch(parsed, intToIpv4(n));
          if (m === p) set.add(tileBaseOf(n));
        }
        bases = [...set].sort((a, b) => a - b);
      } else {
        bases = [];
        for (let b = net.base; b < net.base + size; b += TILE_SIZE) bases.push(b);
      }
      for (const b of bases) {
        if (delegated(b)) delegatedTiles++;
        else tiles.push(tileOf(b));
      }
    }
    sections.push({
      key: subnet.cidr,
      net,
      subnet,
      tiles,
      used: countUsedHosts(net, usedIps),
      usable: usableHosts(net.prefix),
      onlyUsedTiles,
      delegatedTiles,
    });
  }

  // Used addresses outside every site subnet: one /24 section each.
  const fallback = new Map<number, true>();
  for (const n of usedInts) {
    if (longestMatch(parsed, intToIpv4(n)) === null) fallback.set(tileBaseOf(n), true);
  }
  for (const base of fallback.keys()) {
    const net = { base, prefix: 24 };
    sections.push({
      key: `fallback:${base}`,
      net,
      subnet: null,
      tiles: [tileOf(base)],
      used: countUsedHosts(net, usedIps),
      usable: usableHosts(24),
      onlyUsedTiles: false,
      delegatedTiles: 0,
    });
  }

  return sections.sort((a, b) => a.net.base - b.net.base || a.net.prefix - b.net.prefix);
}

// ── color mapping ─────────────────────────────────────────────────────────────

const CELL_BG: Record<CellKind, string> = {
  online: 'bg-emerald-500',
  offline: 'bg-red-500',
  reserved: 'bg-blue-500',
  unknown: 'bg-zinc-600',
  resFree: 'bg-blue-500/50',
  held: 'bg-teal-400',
  ownerOffline: 'bg-amber-500/70',
  conflict: 'bg-orange-500',
};

const CELL_RING: Record<CellKind, string> = {
  online: 'ring-emerald-400',
  offline: 'ring-red-400',
  reserved: 'ring-blue-400',
  unknown: 'ring-zinc-400',
  resFree: 'ring-blue-400',
  held: 'ring-teal-300',
  ownerOffline: 'ring-amber-400',
  conflict: 'ring-orange-400',
};

const CELL_TEXT: Record<CellKind, string> = {
  online: 'text-emerald-400',
  offline: 'text-red-400',
  reserved: 'text-blue-400',
  unknown: 'text-zinc-400',
  resFree: 'text-blue-400',
  held: 'text-teal-300',
  ownerOffline: 'text-amber-400',
  conflict: 'text-orange-400',
};

// ── Legend item ───────────────────────────────────────────────────────────────

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-text-muted">
      <span className={clsx('inline-block h-3 w-3 rounded-sm', color)} />
      {label}
    </span>
  );
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function Tooltip({ cell, col, row }: { cell: CellData; col: number; row: number }) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const item = cell.item;
  const res = cell.reservation;
  const itemName = item ? item.customName || item.hostname || item.mac : null;
  // Position left side for right half of grid, right side otherwise
  const alignRight = col >= 8;
  return (
    <div
      className={clsx(
        'pointer-events-none absolute z-50 whitespace-nowrap rounded-lg border border-border bg-bg-secondary px-3 py-2 text-xs shadow-xl',
        'top-1/2 -translate-y-1/2',
        alignRight ? 'right-[calc(100%+6px)]' : 'left-[calc(100%+6px)]',
        row <= 2 ? 'top-0 translate-y-0' : '',
        row >= 13 ? 'bottom-0 top-auto translate-y-0' : '',
      )}
    >
      <div className="font-mono font-semibold text-text-primary">{anonymize(cell.ip, 'ip')}</div>
      {item && (
        <>
          {itemName && (
            <div className="text-text-secondary mt-0.5">
              {anonymize(itemName, itemName === item.mac ? 'mac' : 'hostname')}
            </div>
          )}
          <div className={clsx('mt-1 font-medium', CELL_TEXT[cellKind(item, null)])}>
            {t(`itemStatus.${item.status}`, item.status)}
          </div>
        </>
      )}
      {res && (
        <div className={clsx('mt-1', CELL_TEXT[cell.kind === 'conflict' || cell.kind === 'held' || cell.kind === 'ownerOffline' ? cell.kind : 'resFree'])}>
          {t('heatmap.tooltipReservation', {
            name: anonymize(res.name, 'hostname'),
            state: reservationStateLabel(t, reservationStateOf(res)),
            defaultValue: 'Reserved: {{name}} ({{state}})',
          })}
        </div>
      )}
      {!res && cell.kind === 'conflict' && (
        <div className="mt-1 text-orange-400">{t('heatmap.tooltipConflict')}</div>
      )}
    </div>
  );
}

// ── /24 tile ──────────────────────────────────────────────────────────────────

function TileGrid({
  tile,
  net,
  showLabel,
  onCellClick,
  canReserve,
}: {
  tile: Tile;
  /** The section's subnet: addresses outside are greyed out, its host addresses can be reserved. */
  net: Ipv4Net;
  /** Label the tile with its /24 (sections of several tiles). */
  showLabel: boolean;
  onCellClick?: (ip: string, target: HeatmapTarget) => void;
  canReserve: boolean;
}) {
  const { t } = useTranslation();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const { anonymize } = useAnonymize();
  const netEnd = net.base + subnetSize(net.prefix);
  const { first, last } = hostRange(net);

  const inSubnet = (idx: number) => tile.base + idx >= net.base && tile.base + idx < netEnd;
  const reservable = (idx: number) => canReserve && tile.base + idx >= first && tile.base + idx <= last;

  const activate = (idx: number) => {
    if (!onCellClick) return;
    const cell = tile.cells[idx];
    if (cell?.item) onCellClick(cell.ip, { kind: 'item', item: cell.item });
    else if (cell?.reservation) onCellClick(cell.ip, { kind: 'reservation', reservation: cell.reservation });
    else if (reservable(idx)) onCellClick(intToIpv4(tile.base + idx), null);
  };

  return (
    <div className="min-w-0">
      {showLabel && (
        <div className="mb-1 font-mono text-[11px] text-text-muted">
          {anonymize(intToIpv4(tile.base), 'ip')}/24
        </div>
      )}

      {/* Column header 0–F */}
      <div className="flex mb-0.5">
        <div className="w-8" /> {/* row label spacer */}
        {Array.from({ length: 16 }, (_, col) => (
          <div key={col} className="flex-1 text-center text-[9px] font-mono text-text-muted leading-none pb-0.5">
            {col.toString(16).toUpperCase()}
          </div>
        ))}
      </div>

      {/* 16 rows */}
      {Array.from({ length: 16 }, (_, row) => (
        <div key={row} className="flex mb-0.5 items-center">
          {/* Row label */}
          <div className="w-8 text-right pr-1.5 text-[9px] font-mono text-text-muted leading-none shrink-0">
            {(row * 16).toString(16).toUpperCase()}x
          </div>
          {Array.from({ length: 16 }, (_, col) => {
            const idx = row * 16 + col;
            const cell = tile.cells[idx];
            const outside = !inSubnet(idx);
            const isHovered = hoveredIdx === idx;
            const ip = intToIpv4(tile.base + idx);
            const clickable = !!onCellClick && !outside && (!!cell || reservable(idx));
            const ariaLabel = !clickable
              ? undefined
              : cell?.item
                ? t('heatmap.openDevice', { ip: anonymize(ip, 'ip'), defaultValue: 'Open the device at {{ip}}' })
                : cell?.reservation
                  ? t('heatmap.openReservation', { ip: anonymize(ip, 'ip'), defaultValue: 'Open the reservation of {{ip}}' })
                  : t('heatmap.reserveIp', { ip: anonymize(ip, 'ip'), defaultValue: 'Reserve {{ip}}' });
            const shown = outside ? null : cell;
            return (
              <div
                key={col}
                className="relative flex-1 px-px"
                onMouseEnter={() => shown && setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
              >
                <div
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={ariaLabel}
                  title={clickable && !cell ? ariaLabel : undefined}
                  onClick={clickable ? () => activate(idx) : undefined}
                  onKeyDown={clickable ? (e: KeyboardEvent<HTMLDivElement>) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      activate(idx);
                    }
                  } : undefined}
                  onFocus={() => shown && setHoveredIdx(idx)}
                  onBlur={() => setHoveredIdx(null)}
                  className={clsx(
                    'h-4 w-full rounded-sm transition-transform focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                    outside ? 'bg-bg-tertiary/30' : shown ? CELL_BG[shown.kind] : 'bg-bg-tertiary',
                    clickable && 'cursor-pointer',
                    !shown && clickable && 'hover:ring-1 hover:ring-accent/60',
                    shown && isHovered && `ring-1 ${CELL_RING[shown.kind]} scale-125 z-10`,
                  )}
                />
                {shown && isHovered && <Tooltip cell={shown} col={col} row={row} />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Subnet section ────────────────────────────────────────────────────────────

function SubnetSection({
  section,
  onCellClick,
  canReserve,
}: {
  section: Section;
  onCellClick?: (ip: string, target: HeatmapTarget) => void;
  canReserve: boolean;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const { net, subnet, tiles, used, usable } = section;
  const { ratio, barClass } = utilisationTone(used, usable);
  const pct = Math.round(ratio * 100);
  const usage = t('subnets.utilisation', {
    used, usable, pct, defaultValue: '{{used}} / {{usable}} addresses used ({{pct}} %)',
  });

  return (
    <div className="rounded-xl bg-bg-secondary p-4">
      {/* Subnet header */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-mono text-sm font-semibold text-text-primary">
          {anonymize(intToIpv4(net.base), 'ip')}<span className="text-text-muted">/{net.prefix}</span>
        </span>
        {subnet?.name && (
          <span className="text-sm text-text-secondary truncate max-w-[16rem]">{anonymize(subnet.name, 'hostname')}</span>
        )}
        {subnet?.vlan != null && (
          <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary">
            {t('subnets.vlanBadge', { vlan: subnet.vlan, defaultValue: 'VLAN {{vlan}}' })}
          </span>
        )}
        {!subnet && (
          <span className="text-[11px] text-text-muted">
            {t('heatmap.undeclaredSubnet', 'Not a subnet of the site')}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2" title={usage}>
          <span
            className="h-1.5 w-24 rounded-full bg-bg-tertiary overflow-hidden"
            role="meter"
            aria-label={usage}
            aria-valuemin={0}
            aria-valuemax={usable}
            aria-valuenow={used}
          >
            <span className={clsx('block h-full rounded-full', barClass)} style={{ width: `${Math.max(pct, used > 0 ? 2 : 0)}%` }} />
          </span>
          <span className="text-xs text-text-muted tabular-nums">{used} / {usable}</span>
        </span>
      </div>

      {(section.onlyUsedTiles || section.delegatedTiles > 0) && (
        <p className="mb-3 text-xs text-text-muted">
          {section.onlyUsedTiles && t('heatmap.onlyUsedBlocks', 'Wide subnet: only the /24 blocks in use are shown.')}
          {section.onlyUsedTiles && section.delegatedTiles > 0 && ' '}
          {section.delegatedTiles > 0 && t('heatmap.delegatedBlocks', {
            count: section.delegatedTiles,
            defaultValue_one: '{{count}} /24 block is shown in its own subnet.',
            defaultValue_other: '{{count}} /24 blocks are shown in their own subnet.',
          })}
        </p>
      )}

      {tiles.length === 0 ? (
        section.delegatedTiles === 0 && (
          <p className="text-xs text-text-muted">{t('heatmap.noUsedAddress', 'No address in use.')}</p>
        )
      ) : (
        <div className={clsx('grid gap-4', tiles.length > 1 && 'lg:grid-cols-2')}>
          {tiles.map((tile) => (
            <TileGrid
              key={tile.base}
              tile={tile}
              net={net}
              showLabel={tiles.length > 1 || net.prefix < 24}
              onCellClick={onCellClick}
              canReserve={canReserve}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

interface SubnetHeatmapProps {
  items: SiteItem[];
  reservations: IpReservation[];
  /** The site (its subnets are loaded when `subnets` is not given). Default: the site of the items. */
  siteId?: number;
  /** The site's subnets (GET /sites/:id/subnets); undefined = loaded here. */
  subnets?: SiteSubnet[] | null;
  /** Cell click: device (used IP), reservation (reserved IP) or null (free IP, only with canReserve). */
  onCellClick?: (ip: string, target: HeatmapTarget) => void;
  /** Free cells are clickable to reserve the IP (site write). */
  canReserve?: boolean;
}

export function SubnetHeatmap({ items, reservations, siteId, subnets: subnetsProp, onCellClick, canReserve = false }: SubnetHeatmapProps) {
  const { t } = useTranslation();

  // Subnets: given by the page, else loaded for the site (of the rows when no siteId is given).
  const effectiveSiteId = siteId ?? items[0]?.siteId ?? reservations[0]?.siteId ?? null;
  const { subnets: loaded } = useSiteSubnets(subnetsProp === undefined ? effectiveSiteId : null);
  const subnets = subnetsProp === undefined ? loaded : subnetsProp;

  const cellByInt = useMemo(() => {
    const itemByIp = new Map<string, SiteItem>();
    const resByIp = new Map<string, IpReservation>();
    for (const item of items) {
      if (ipv4ToInt(item.ip) === null) continue;
      const prev = itemByIp.get(item.ip);
      itemByIp.set(item.ip, prev ? betterItem(prev, item) : item);
    }
    for (const r of reservations) {
      if (ipv4ToInt(r.ip) !== null) resByIp.set(r.ip, r);
    }
    const map = new Map<number, CellData>();
    for (const ip of new Set([...itemByIp.keys(), ...resByIp.keys()])) {
      const n = ipv4ToInt(ip);
      if (n === null) continue;
      const item = itemByIp.get(ip) ?? null;
      const reservation = resByIp.get(ip) ?? null;
      map.set(n, { ip, item, reservation, kind: cellKind(item, reservation) });
    }
    return map;
  }, [items, reservations]);

  const sections = useMemo(() => buildSections(cellByInt, subnets), [cellByInt, subnets]);

  if (sections.length === 0) {
    return (
      <div className="rounded-xl bg-bg-secondary p-16 text-center">
        <p className="text-text-muted text-sm">{t('heatmap.noData')}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Legend */}
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <LegendDot color={CELL_BG.online}       label={t('heatmap.legendOnline')} />
        <LegendDot color={CELL_BG.offline}      label={t('heatmap.legendOffline')} />
        <LegendDot color={CELL_BG.reserved}     label={t('heatmap.legendReserved')} />
        <LegendDot color={CELL_BG.unknown}      label={t('heatmap.legendUnknown')} />
        <LegendDot color={CELL_BG.resFree}      label={t('heatmap.legendReservedFree', 'Reserved, free')} />
        <LegendDot color={CELL_BG.held}         label={t('heatmap.legendHeld', 'Held by its device')} />
        <LegendDot color={CELL_BG.ownerOffline} label={t('heatmap.legendOwnerOffline', 'Owner offline')} />
        <LegendDot color={CELL_BG.conflict}     label={t('heatmap.legendConflict')} />
        <LegendDot color="bg-bg-tertiary"         label={t('heatmap.legendEmpty')} />
        <span className="ml-auto text-xs text-text-muted">
          {onCellClick
            ? canReserve
              ? t('heatmap.clickHintReserve', 'Click a cell to open the device or reserve the IP')
              : t('heatmap.clickHint', 'Click a cell to open the device')
            : t('heatmap.hoverHint')}
        </span>
      </div>

      {/* One card per subnet */}
      <div className="flex flex-col gap-4">
        {sections.map((section) => (
          <SubnetSection
            key={section.key}
            section={section}
            onCellClick={onCellClick}
            canReserve={canReserve}
          />
        ))}
      </div>
    </div>
  );
}
