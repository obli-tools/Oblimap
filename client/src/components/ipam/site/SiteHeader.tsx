import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { FolderTree, Lock, MapPin, Pencil, Radar, RefreshCw, Trash2 } from 'lucide-react';
import type { Site } from '@oblimap/shared';
import { siteApi } from '@/api/site.api';
import { useAnonymize } from '@/utils/anonymize';
import { apiErrorBody, toastApiError } from '@/utils/apiError';
import { PageHeader } from '@/components/common/PageHeader';
import { IconButton } from '@/components/common/IconButton';
import { Button } from '@/components/common/Button';
import { SiteModal } from '@/components/ipam/SiteModal';

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

/**
 * Header of the site page: back, title, group chip, read-only pill, Edit
 * (site writers: SiteModal), Delete (`onDelete`, given to site writers
 * holding sites.manage), Rescan (site writers: POST /sites/:id/rescan, no
 * probes.manage needed) and Refresh. `children` renders under the title
 * (the stats line).
 */
export function SiteHeader({
  site,
  groupName,
  canWrite,
  onRefresh,
  onSaved,
  onDelete,
  children,
}: {
  site: Site;
  /** Name of the site's group when the user's tree shows it (null: no chip). */
  groupName: string | null;
  canWrite: boolean;
  onRefresh: () => void;
  /** After the site was edited (the saved site). */
  onSaved?: (site: Site) => void;
  /** Delete the site (absent: not allowed). */
  onDelete?: () => void;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const [rescanning, setRescanning] = useState(false);
  const [editing, setEditing] = useState(false);

  async function rescan() {
    if (rescanning) return;
    setRescanning(true);
    try {
      const { sent, queued, skipped = 0 } = await siteApi.rescan(site.id);
      if (sent + queued === 0 && skipped > 0) {
        toast(t('siteDetail.rescan.busy', 'The probes of this site have another command pending (update or uninstall): no rescan was requested.'));
      } else if (sent + queued === 0) {
        toast(t('siteDetail.rescan.noProbe', 'No approved probe scans this site.'));
      } else {
        toast.success(t('siteDetail.rescan.done', {
          sent,
          queued,
          defaultValue: 'Rescan requested: {{sent}} probe(s) now, {{queued}} at their next contact.',
        }));
      }
    } catch (err) {
      if (httpStatus(err) === 429) {
        const body = apiErrorBody(err) as { retryAfterSeconds?: unknown } | undefined;
        const seconds = typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : 60;
        toast.error(t('siteDetail.rescan.rateLimited', {
          seconds,
          defaultValue: 'A rescan of this site was requested less than a minute ago. Try again in {{seconds}} s.',
        }));
      } else {
        toastApiError(err, t('siteDetail.rescan.failed', 'Could not request the rescan'));
      }
    } finally {
      setRescanning(false);
    }
  }

  return (
    <PageHeader
      backTo="/sites"
      icon={<MapPin className="h-5 w-5" />}
      title={anonymize(site.name, 'hostname')}
      subtitle={site.description ?? undefined}
      actions={
        <>
          {canWrite && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void rescan()}
              loading={rescanning}
              title={t('siteDetail.rescan.hint', 'Ask the probes of this site to scan the network now')}
              className="gap-1.5"
            >
              {!rescanning && <Radar size={14} />}
              {t('siteDetail.rescan.button', 'Rescan')}
            </Button>
          )}
          {canWrite && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setEditing(true)}
              className="gap-1.5"
            >
              <Pencil size={14} />
              {t('common.edit', 'Edit')}
            </Button>
          )}
          {canWrite && onDelete && (
            <Button
              variant="danger"
              size="sm"
              onClick={onDelete}
              className="gap-1.5"
            >
              <Trash2 size={14} />
              {t('common.delete', 'Delete')}
            </Button>
          )}
          <IconButton
            label={t('common.refresh')}
            icon={<RefreshCw size={16} />}
            size="lg"
            onClick={onRefresh}
          />
        </>
      }
    >
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {site.groupId !== null && groupName !== null && (
          <Link
            to={`/group/${site.groupId}`}
            className="inline-flex items-center gap-1 rounded-full bg-bg-secondary px-2 py-0.5 text-xs text-text-secondary transition-colors hover:text-accent"
            title={t('siteDetail.groupChipHint', 'Open the group of this site')}
          >
            <FolderTree size={11} />
            {anonymize(groupName, 'hostname')}
          </Link>
        )}
        {!canWrite && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-bg-secondary px-2 py-0.5 text-xs text-text-muted"
            title={t('siteDetail.readOnlyHint', 'You can view this site but not change it')}
          >
            <Lock size={11} />
            {t('siteDetail.readOnly', 'Read only')}
          </span>
        )}
      </div>
      {children}
      {canWrite && editing && (
        <SiteModal
          site={site}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            onSaved?.(saved);
          }}
        />
      )}
    </PageHeader>
  );
}
