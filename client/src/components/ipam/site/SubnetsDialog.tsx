import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Network, Pencil, Plus, Radar, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import {
  siteSubnetsApi,
  parseCidr,
  formatCidr,
  ipv4ToInt,
  isHostOf,
  utilisationTone,
  SITE_SUBNET_MIN_PREFIX,
  SITE_SUBNET_MAX_PREFIX,
  type SiteSubnet,
  type SiteSubnetSource,
} from '@/api/siteSubnets.api';
import type { SiteProbe } from '@/api/site.api';
import { toastApiError } from '@/utils/apiError';
import { useAnonymize } from '@/utils/anonymize';
import { formatRelative } from '@/utils/formatRelative';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { fieldClass } from './DeviceModal';

/**
 * Subnets of a site (site write): the prefixes the site's probes scan and
 * the subnets added by hand, with their name, VLAN, gateway and description.
 * A probe prefix gets its metadata through a row of the same CIDR (POST);
 * deleting that row only removes the metadata (the probe keeps reporting
 * the prefix). Manual subnets can also change their CIDR.
 */

type FormState = {
  /** Row edited (null: new row; for a probe-only prefix, `cidr` is fixed). */
  id: number | null;
  /** The CIDR cannot change (a probe-reported prefix). */
  cidrLocked: boolean;
  cidr: string;
  name: string;
  vlan: string;
  gateway: string;
  description: string;
};

const EMPTY_FORM: FormState = { id: null, cidrLocked: false, cidr: '', name: '', vlan: '', gateway: '', description: '' };

function formOf(s: SiteSubnet): FormState {
  return {
    id: s.id,
    cidrLocked: s.source !== 'manual',
    cidr: s.cidr,
    name: s.name ?? '',
    vlan: s.vlan != null ? String(s.vlan) : '',
    gateway: s.gateway ?? '',
    description: s.description ?? '',
  };
}

/** Prefix the server accepts for metadata (/16–/30). */
function editablePrefix(prefix: number): boolean {
  return prefix >= SITE_SUBNET_MIN_PREFIX && prefix <= SITE_SUBNET_MAX_PREFIX;
}

/** A text input shown masked in anonymous mode until it is focused. */
function MaskedInput({
  id, value, onChange, masked, placeholder, disabled, autoFocus, invalid, maxLength,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  masked: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  maxLength?: number;
}) {
  const { isAnonymous } = useAnonymize();
  const [revealed, setRevealed] = useState(false);
  const hide = isAnonymous && !revealed && value !== '';
  return (
    <input
      id={id}
      type="text"
      value={hide ? masked : value}
      readOnly={hide}
      onFocus={() => setRevealed(true)}
      onBlur={() => setRevealed(false)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      autoComplete="off"
      spellCheck={false}
      maxLength={maxLength}
      aria-invalid={invalid}
      className={fieldClass}
    />
  );
}

function SourceBadge({ source }: { source: SiteSubnetSource }) {
  const { t } = useTranslation();
  const label = source === 'manual'
    ? t('subnets.source.manual', 'Manual')
    : source === 'probe'
      ? t('subnets.source.probe', 'Scanned by a probe')
      : t('subnets.source.manualProbe', 'Manual + probe');
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded border',
        source === 'manual'
          ? 'bg-bg-tertiary text-text-secondary border-border'
          : 'bg-accent/10 text-accent border-accent/30',
      )}
    >
      {source !== 'manual' && <Radar size={10} />}
      {label}
    </span>
  );
}

function SubnetForm({
  siteId,
  initial,
  onDone,
  onCancel,
}: {
  siteId: number;
  initial: FormState;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const formId = useId();
  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const net = parseCidr(form.cidr);
  const cidrError = !form.cidr.trim()
    ? null
    : !net
      ? t('subnets.form.cidrInvalid', 'Expected an IPv4 CIDR like 192.168.1.0/24')
      : !editablePrefix(net.prefix)
        ? t('subnets.form.prefixRange', {
          min: SITE_SUBNET_MIN_PREFIX, max: SITE_SUBNET_MAX_PREFIX,
          defaultValue: 'The prefix must be between /{{min}} and /{{max}}',
        })
        : null;
  const vlanText = form.vlan.trim();
  const vlanNum = vlanText === '' ? null : Number(vlanText);
  const vlanError = vlanNum !== null && (!/^\d{1,4}$/.test(vlanText) || vlanNum < 1 || vlanNum > 4094)
    ? t('subnets.form.vlanInvalid', 'A VLAN id is a number from 1 to 4094')
    : null;
  const gwText = form.gateway.trim();
  const gwInt = gwText === '' ? null : ipv4ToInt(gwText);
  const gatewayError = gwText === ''
    ? null
    : gwInt === null
      ? t('subnets.form.gatewayInvalid', 'Expected an IPv4 address')
      : net && !isHostOf(net, gwInt)
        ? t('subnets.form.gatewayOutside', 'The gateway must be a host address of the subnet')
        : null;
  const invalid = !net || !!cidrError || !!vlanError || !!gatewayError;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (invalid || saving || !net) return;
    setSaving(true);
    const fields = {
      name: form.name.trim() || null,
      vlan: vlanNum,
      gateway: gwText || null,
      description: form.description.trim() || null,
    };
    try {
      if (form.id !== null) {
        await siteSubnetsApi.update(siteId, form.id, {
          ...fields,
          ...(form.cidrLocked ? {} : { cidr: formatCidr(net) }),
        });
        toast.success(t('subnets.updated', 'Subnet saved'));
      } else {
        await siteSubnetsApi.create(siteId, { cidr: formatCidr(net), ...fields });
        toast.success(form.cidrLocked ? t('subnets.updated', 'Subnet saved') : t('subnets.created', 'Subnet added'));
      }
      onDone();
    } catch (err) {
      // e.g. 409 "This subnet already exists on the site", 400 gateway outside.
      toastApiError(err, t('subnets.failedSave', 'The subnet could not be saved'));
    } finally {
      setSaving(false);
    }
  }

  const label = 'block text-sm text-text-secondary mb-1.5';
  const errorText = 'mt-1 text-xs text-red-400';
  return (
    <form id={formId} onSubmit={(e) => void submit(e)} className="rounded-lg border border-accent/40 bg-bg-tertiary/40 p-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${formId}-cidr`} className={label}>
            {t('subnets.form.cidr', 'Subnet (CIDR)')} <span className="text-red-400">*</span>
          </label>
          <MaskedInput
            id={`${formId}-cidr`}
            value={form.cidr}
            masked={net ? `${anonymize(formatCidr(net).split('/')[0], 'ip')}/${net.prefix}` : anonymize(form.cidr, 'ip')}
            onChange={(v) => set('cidr', v)}
            placeholder="192.168.10.0/24"
            disabled={form.cidrLocked}
            autoFocus={!form.cidrLocked}
            invalid={!!cidrError}
            maxLength={18}
          />
          {cidrError
            ? <p className={errorText}>{cidrError}</p>
            : form.cidrLocked && (
              <p className="mt-1 text-xs text-text-muted">
                {t('subnets.form.cidrLocked', 'Reported by a probe: only its details can change.')}
              </p>
            )}
        </div>
        <div>
          <label htmlFor={`${formId}-name`} className={label}>{t('subnets.form.name', 'Name')}</label>
          <MaskedInput
            id={`${formId}-name`}
            value={form.name}
            masked={anonymize(form.name, 'hostname')}
            onChange={(v) => set('name', v)}
            placeholder={t('subnets.form.namePlaceholder', 'e.g. Office LAN')}
            autoFocus={form.cidrLocked}
            maxLength={100}
          />
        </div>
        <div>
          <label htmlFor={`${formId}-vlan`} className={label}>{t('subnets.form.vlan', 'VLAN')}</label>
          <input
            id={`${formId}-vlan`}
            type="text"
            inputMode="numeric"
            value={form.vlan}
            onChange={(e) => set('vlan', e.target.value)}
            placeholder="10"
            maxLength={4}
            aria-invalid={!!vlanError}
            className={fieldClass}
          />
          {vlanError && <p className={errorText}>{vlanError}</p>}
        </div>
        <div>
          <label htmlFor={`${formId}-gw`} className={label}>{t('subnets.form.gateway', 'Gateway')}</label>
          <MaskedInput
            id={`${formId}-gw`}
            value={form.gateway}
            masked={anonymize(form.gateway, 'ip')}
            onChange={(v) => set('gateway', v)}
            placeholder={net ? formatCidr({ base: net.base + 1, prefix: 32 }).split('/')[0] : '192.168.10.1'}
            invalid={!!gatewayError}
            maxLength={15}
          />
          {gatewayError && <p className={errorText}>{gatewayError}</p>}
        </div>
      </div>
      <div>
        <label htmlFor={`${formId}-desc`} className={label}>{t('subnets.form.description', 'Description')}</label>
        <MaskedInput
          id={`${formId}-desc`}
          value={form.description}
          masked={anonymize(form.description, 'hostname')}
          onChange={(v) => set('description', v)}
          maxLength={1000}
        />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={saving}>{t('common.cancel')}</Button>
        <Button type="submit" size="sm" loading={saving} disabled={invalid}>{t('common.save', 'Save')}</Button>
      </div>
    </form>
  );
}

export function SubnetsDialog({
  siteId,
  subnets,
  loading,
  probes,
  onChanged,
  onClose,
}: {
  siteId: number;
  /** The site's subnets (useSiteSubnets); null = not loaded. */
  subnets: SiteSubnet[] | null;
  loading: boolean;
  /** The site's probes, for the names of the probes scanning a subnet. */
  probes: SiteProbe[] | null;
  /** A subnet was added / changed / deleted (reload the list). */
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { anonymize } = useAnonymize();
  /** 'new', the CIDR of the subnet being edited, or null. */
  const [editing, setEditing] = useState<string | null>(null);

  const probeNames = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of probes ?? []) map.set(p.id, p.name);
    return map;
  }, [probes]);

  const shownCidr = (s: SiteSubnet) => `${anonymize(s.networkAddress, 'ip')}/${s.prefix}`;

  async function remove(s: SiteSubnet) {
    if (s.id === null) return;
    const ok = await confirm({
      message: s.source === 'manual'
        ? t('subnets.confirmDelete', { cidr: shownCidr(s), defaultValue: 'Delete the subnet {{cidr}}? Its devices are kept.' })
        : t('subnets.confirmClear', {
          cidr: shownCidr(s),
          defaultValue: 'Remove the details of {{cidr}}? A probe still scans it: the subnet stays listed, without name, VLAN or gateway.',
        }),
      danger: true,
    });
    if (!ok) return;
    try {
      await siteSubnetsApi.remove(siteId, s.id);
      toast.success(t('subnets.deleted', 'Subnet deleted'));
      if (editing === s.cidr) setEditing(null);
      onChanged();
    } catch (err) {
      toastApiError(err, t('subnets.failedDelete', 'The subnet could not be deleted'));
    }
  }

  const done = () => { setEditing(null); onChanged(); };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('subnets.title', 'Subnets')}
      icon={<Network className="w-4 h-4 text-accent" />}
      size="xl"
      footer={
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t('common.close', 'Close')}</Button>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-sm text-text-muted max-w-prose">
            {t('subnets.intro', 'The subnets the site\'s probes scan are listed automatically. Add the other networks of the site, and give each subnet a name, a VLAN, a gateway and a description: the device list and the heatmap group the devices by subnet.')}
          </p>
          {editing !== 'new' && (
            <Button type="button" size="sm" onClick={() => setEditing('new')}>
              <Plus size={14} className="mr-1" />
              {t('subnets.add', 'Add a subnet')}
            </Button>
          )}
        </div>

        {editing === 'new' && (
          <SubnetForm siteId={siteId} initial={EMPTY_FORM} onDone={done} onCancel={() => setEditing(null)} />
        )}

        {subnets === null ? (
          loading
            ? <div className="flex justify-center py-8"><LoadingSpinner /></div>
            : <p role="alert" className="text-sm text-red-400">{t('subnets.loadFailed', 'The subnets could not be loaded.')}</p>
        ) : subnets.length === 0 ? (
          <p className="text-sm text-text-muted py-4 text-center">
            {t('subnets.empty', 'No subnet yet: no probe reported a scanned network and none was added.')}
          </p>
        ) : (
          <ul className="space-y-2">
            {subnets.map((s) => {
              const { ratio, barClass } = utilisationTone(s.used, s.usable);
              const canEdit = s.id !== null || editablePrefix(s.prefix);
              const scanners = s.probeIds.map((id) => probeNames.get(id) ?? `#${id}`);
              if (editing === s.cidr) {
                return (
                  <li key={s.cidr}>
                    <SubnetForm siteId={siteId} initial={formOf(s)} onDone={done} onCancel={() => setEditing(null)} />
                  </li>
                );
              }
              return (
                <li key={s.cidr} className="rounded-lg bg-bg-primary/50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-text-primary">{shownCidr(s)}</span>
                    {s.name && <span className="text-sm text-text-secondary">{anonymize(s.name, 'hostname')}</span>}
                    {s.vlan != null && (
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary">
                        {t('subnets.vlanBadge', { vlan: s.vlan, defaultValue: 'VLAN {{vlan}}' })}
                      </span>
                    )}
                    <SourceBadge source={s.source} />
                    <span className="ml-auto flex items-center gap-1">
                      {canEdit ? (
                        <IconButton
                          label={t('subnets.edit', 'Edit the subnet')}
                          icon={<Pencil size={14} />}
                          size="sm"
                          onClick={() => setEditing(s.cidr)}
                        />
                      ) : (
                        <span className="text-[11px] text-text-muted" title={t('subnets.tooWideHint', {
                          min: SITE_SUBNET_MIN_PREFIX, defaultValue: 'Details can be set on subnets of /{{min}} or narrower',
                        })}>
                          {t('subnets.tooWide', 'Too wide to describe')}
                        </span>
                      )}
                      {s.id !== null && (
                        <IconButton
                          label={s.source === 'manual'
                            ? t('subnets.delete', 'Delete the subnet')
                            : t('subnets.clear', 'Remove the details')}
                          icon={<Trash2 size={14} />}
                          size="sm"
                          variant="danger"
                          onClick={() => void remove(s)}
                        />
                      )}
                    </span>
                  </div>
                  <div className="mt-2 grid gap-x-4 gap-y-1 text-xs text-text-muted sm:grid-cols-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-1.5 w-24 rounded-full bg-bg-tertiary overflow-hidden"
                        role="meter"
                        aria-valuemin={0}
                        aria-valuemax={s.usable}
                        aria-valuenow={s.used}
                        aria-label={t('subnets.utilisationShort', 'Utilisation')}
                      >
                        <span className={clsx('block h-full rounded-full', barClass)} style={{ width: `${Math.max(Math.round(ratio * 100), s.used > 0 ? 2 : 0)}%` }} />
                      </span>
                      <span className="tabular-nums">
                        {t('subnets.utilisation', {
                          used: s.used, usable: s.usable, pct: Math.round(ratio * 100),
                          defaultValue: '{{used}} / {{usable}} addresses used ({{pct}} %)',
                        })}
                      </span>
                    </div>
                    {s.gateway && (
                      <div>{t('subnets.gatewayLabel', { ip: anonymize(s.gateway, 'ip'), defaultValue: 'Gateway {{ip}}' })}</div>
                    )}
                    {scanners.length > 0 && (
                      <div className="flex items-center gap-1 min-w-0">
                        <Radar size={11} className="shrink-0 text-accent" />
                        <span className="truncate">
                          {t('subnets.scannedBy', {
                            probes: scanners.map((n) => anonymize(n, 'hostname')).join(', '),
                            when: formatRelative(s.lastScannedAt, t),
                            defaultValue: 'Scanned by {{probes}} · {{when}}',
                          })}
                        </span>
                      </div>
                    )}
                    {s.description && (
                      <div className="sm:col-span-2 text-text-secondary break-words">{anonymize(s.description, 'hostname')}</div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
