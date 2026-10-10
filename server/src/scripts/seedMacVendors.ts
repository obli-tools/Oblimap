/**
 * seedMacVendors.ts
 *
 * Downloads the current IEEE MAC address registries — MA-L (24-bit OUI),
 * MA-M (28-bit) and MA-S (36-bit) — and upserts them into the mac_vendors
 * table through the OUI registry service (the server also does this by
 * itself in the background: at boot when the table is empty and every 30
 * days). Custom name overrides (custom_name column) are left completely
 * untouched — only vendor_name, prefix_bits and updated_at are written.
 *
 * Usage:
 *   npm run seed:oui            (from server/)
 *   npx tsx server/src/scripts/seedMacVendors.ts
 *
 * The script exits with code 0 on success (every registry stored), 1 on
 * error or when a registry could not be downloaded.
 */

import '../env';               // loads .env so DB credentials are available
import { db } from '../db';
import { OUI_REGISTRIES, seedIfNeeded } from '../services/ouiRegistry.service';

async function main(): Promise<number> {
  console.log('[seedMacVendors] Downloading the IEEE registries…');
  for (const reg of OUI_REGISTRIES) console.log(`  ${reg.key} (${reg.bits} bits): ${reg.url}`);

  const result = await seedIfNeeded({ force: true });
  for (const r of result.registries) {
    console.log(r.error
      ? `[seedMacVendors] ${r.key}: FAILED — ${r.error}`
      : `[seedMacVendors] ${r.key}: ${r.rows} prefixes upserted`);
  }
  console.log(`[seedMacVendors] Done — ${result.inserted} prefixes upserted${result.complete ? '' : ' (incomplete)'}.`);

  // Quick sanity check
  const total = await db('mac_vendors').count('* as n').first();
  const overrides = await db('mac_vendors').whereNotNull('custom_name').count('* as n').first();
  console.log(
    `[seedMacVendors] Table now contains ${String(total?.n ?? 0)} rows` +
    ` (${String(overrides?.n ?? 0)} custom overrides preserved).`,
  );
  return result.complete ? 0 : 1;
}

main()
  .then(async (code) => {
    await db.destroy();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('[seedMacVendors] Unexpected error:', err);
    await db.destroy().catch(() => undefined);
    process.exit(1);
  });
