/**
 * CredentialsSection — Basic auth credentials of a rule:
 * one default plus per-site overrides. Write-only: the server stores them
 * encrypted and returns only the masked username, so nothing is ever
 * prefilled, and the password lives in this form only until it is sent.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, KeyRound, Loader2, Plus, ShieldAlert } from 'lucide-react';
import type { DeviceCheckCredentialInfo, DeviceCheckVariant, Site } from '@oblimap/shared';
import { deviceChecksApi, describeDeviceCheckError, parseDeviceCheckError } from '@/api/deviceChecks.api';
import { useAnonymize } from '@/utils/anonymize';
import { isHandled } from '@/utils/apiError';
import { cn } from '@/utils/cn';
import { inputCls } from './GeneralSection';

interface CredentialFormProps {
  onSubmit: (username: string, password: string) => Promise<boolean>;
  onCancel: () => void;
}

function CredentialForm({ onSubmit, onCancel }: CredentialFormProps) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!username || !password) return;
    setSaving(true);
    const ok = await onSubmit(username, password);
    setSaving(false);
    if (ok) { setUsername(''); setPassword(''); }
  };

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <input
        value={username}
        maxLength={128}
        onChange={(e) => setUsername(e.target.value)}
        placeholder={t('deviceChecks.editor.credentials.username', 'Username')}
        autoComplete="off"
        spellCheck={false}
        className={cn(inputCls, 'w-44')}
      />
      <input
        type="password"
        value={password}
        maxLength={256}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
        placeholder={t('deviceChecks.editor.credentials.password', 'Password')}
        autoComplete="new-password"
        className={cn(inputCls, 'w-44')}
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={saving || !username || !password}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
      >
        {saving && <Loader2 size={12} className="animate-spin" />}
        {t('common.save', 'Save')}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
      >
        {t('common.cancel', 'Cancel')}
      </button>
    </div>
  );
}

interface CredentialsSectionProps {
  /** null while the rule is not saved yet. */
  ruleId: number | null;
  credentials: DeviceCheckCredentialInfo[];
  variants: DeviceCheckVariant[];
  /** Every site of the workspace (names of the existing overrides). */
  sites: Site[];
  /** Sites of the rule's scope: the only ones a new override can be added for. */
  overrideSites: Site[];
  userNames: Map<number, string>;
  /** Called after a change so the page reloads the rule (credential metadata). */
  onChanged: () => void;
}

export function CredentialsSection({ ruleId, credentials, variants, sites, overrideSites, userNames, onChanged }: CredentialsSectionProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const [editing, setEditing] = useState<number | null | undefined>(undefined); // undefined = no form open
  const [clearing, setClearing] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [keyMissing, setKeyMissing] = useState(false);
  const [newSiteId, setNewSiteId] = useState<number | ''>('');

  const basicVariants = variants.filter((v) => v.request.auth === 'basic');
  if (basicVariants.length === 0) return null;
  const overHttp = basicVariants.some((v) => v.request.scheme === 'http');

  const siteName = (id: number) => anonymize(sites.find((s) => s.id === id)?.name ?? `#${id}`, 'hostname');
  const bySite = new Map(credentials.map((c) => [c.siteId, c]));
  const overrides = credentials.filter((c) => c.siteId !== null);
  const freeSites = overrideSites.filter((s) => !bySite.has(s.id));
  // The scope may have changed since a site was picked.
  const pickedSiteId = newSiteId !== '' && freeSites.some((s) => s.id === newSiteId) ? newSiteId : '';

  const save = async (siteId: number | null, username: string, password: string): Promise<boolean> => {
    if (ruleId === null) return false;
    try {
      await deviceChecksApi.setCredentials(ruleId, { siteId, username, password });
      toast.success(t('deviceChecks.editor.credentials.saved', 'Credentials saved'));
      setEditing(undefined);
      setKeyMissing(false);
      onChanged();
      return true;
    } catch (err) {
      const e = parseDeviceCheckError(err);
      if (e.code === 'encryption_key_missing') setKeyMissing(true);
      if (!isHandled(err)) toast.error(describeDeviceCheckError(err, t, t('deviceChecks.editor.credentials.saveFailed', 'Failed to save the credentials')));
      return false;
    }
  };

  const clear = async (siteId: number | null) => {
    if (ruleId === null) return;
    setBusy(true);
    try {
      await deviceChecksApi.clearCredentials(ruleId, siteId);
      toast.success(t('deviceChecks.editor.credentials.cleared', 'Credentials cleared'));
      setClearing(undefined);
      onChanged();
    } catch (err) {
      toast.error(describeDeviceCheckError(err, t, t('deviceChecks.editor.credentials.clearFailed', 'Failed to clear the credentials')));
    } finally {
      setBusy(false);
    }
  };

  const row = (siteId: number | null, info: DeviceCheckCredentialInfo | undefined) => {
    const key = siteId ?? 'default';
    const updatedBy = info?.updatedBy != null ? userNames.get(info.updatedBy) : undefined;
    return (
      <li key={key} className="rounded-md bg-bg-tertiary/40 px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="min-w-[8rem] text-sm font-medium text-text-primary">
            {siteId === null
              ? t('deviceChecks.editor.credentials.default', 'Default (all sites)')
              : siteName(siteId)}
          </span>
          {info ? (
            <>
              <span className="font-mono text-xs text-text-secondary">{anonymize(info.usernameMasked, 'username')}</span>
              <span className="text-[11px] text-text-muted">
                {t('deviceChecks.editor.credentials.updated', {
                  when: new Date(info.updatedAt).toLocaleString(),
                  who: updatedBy ? anonymize(updatedBy, 'username') : info.updatedBy != null ? `#${info.updatedBy}` : '—',
                  defaultValue: 'Updated {{when}} by {{who}}',
                })}
              </span>
            </>
          ) : (
            <span className="text-xs italic text-text-muted">{t('deviceChecks.editor.credentials.notSet', 'Not set')}</span>
          )}
          <div className="ml-auto flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => { setEditing(siteId); setClearing(undefined); }}
              disabled={ruleId === null}
              className="text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
            >
              {info ? t('deviceChecks.editor.credentials.replace', 'Replace') : t('deviceChecks.editor.credentials.set', 'Set')}
            </button>
            {info && (clearing === siteId ? (
              <span className="flex items-center gap-1.5">
                <span className="text-text-secondary">{t('deviceChecks.editor.credentials.confirmClear', 'Clear?')}</span>
                <button type="button" disabled={busy} onClick={() => void clear(siteId)} className="font-medium text-red-400 hover:underline">
                  {t('common.yes', 'Yes')}
                </button>
                <button type="button" onClick={() => setClearing(undefined)} className="text-text-muted hover:underline">
                  {t('common.no', 'No')}
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => { setClearing(siteId); setEditing(undefined); }} className="text-text-muted hover:text-red-400">
                {t('deviceChecks.editor.credentials.clear', 'Clear')}
              </button>
            ))}
          </div>
        </div>
        {editing === siteId && (
          <CredentialForm onSubmit={(u, p) => save(siteId, u, p)} onCancel={() => setEditing(undefined)} />
        )}
      </li>
    );
  };

  return (
    <div className="space-y-3">
      {keyMissing && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          <ShieldAlert size={14} className="mt-0.5 shrink-0" />
          {t('deviceChecks.errors.encryption_key_missing', 'The server has no DATA_ENCRYPTION_KEY: credentials cannot be stored')}
        </div>
      )}
      {overHttp && (
        <p className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          {t('deviceChecks.editor.credentials.httpWarning', 'Basic auth over HTTP is sent in clear on the shop LAN.')}
        </p>
      )}
      <p className="flex items-start gap-1.5 text-[11px] text-text-muted">
        <KeyRound size={12} className="mt-0.5 shrink-0" />
        {t('deviceChecks.editor.credentials.intro', 'Stored encrypted and never shown again. A site override wins over the default. Probes only receive them over HTTPS, and only for devices whose MAC they verified.')}
      </p>
      {ruleId === null && (
        <p className="text-xs text-amber-400">{t('deviceChecks.editor.credentials.saveFirst', 'Save the rule first, then set its credentials.')}</p>
      )}

      <ul className="space-y-2">
        {row(null, bySite.get(null))}
        {overrides.map((c) => row(c.siteId, c))}
        {editing !== undefined && editing !== null && !bySite.has(editing) && row(editing, undefined)}
      </ul>

      {ruleId !== null && freeSites.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={pickedSiteId}
            onChange={(e) => setNewSiteId(e.target.value ? Number(e.target.value) : '')}
            className={cn(inputCls, 'w-56 text-xs')}
          >
            <option value="">{t('deviceChecks.editor.credentials.pickSite', 'Site override for…')}</option>
            {freeSites.map((s) => <option key={s.id} value={s.id}>{anonymize(s.name, 'hostname')}</option>)}
          </select>
          <button
            type="button"
            disabled={pickedSiteId === ''}
            onClick={() => { if (pickedSiteId !== '') { setEditing(pickedSiteId); setClearing(undefined); setNewSiteId(''); } }}
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
          >
            <Plus size={12} />{t('deviceChecks.editor.credentials.addOverride', 'Add a site override')}
          </button>
        </div>
      )}
    </div>
  );
}
