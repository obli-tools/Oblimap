import { db } from '../db';
import nodemailer from 'nodemailer';
import type { SmtpServer } from '@oblimap/shared';
import * as secretBox from '../utils/secretBox';
import { AppError } from '../middleware/errorHandler';

// SMTP passwords are encrypted at rest with secretBox (AAD `smtp:${id}`)
// when DATA_ENCRYPTION_KEY is configured; rows written before (or without a
// key) hold plaintext, which keeps working (decryptString passes it through).
// The password never leaves the server: API responses only say `passwordSet`.

interface SmtpServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password?: string | null;
  password_encrypted?: string | null;
  from_address: string;
  tenant_id: number | null;
  created_at: Date;
  updated_at: Date;
}

/** Server-internal record with the password decrypted (transport building only). */
export interface SmtpServerRecord {
  id: number;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from_address: string;
  tenant_id: number | null;
  created_at: Date;
  updated_at: Date;
}

/** API view: never the password, only whether one is stored. */
export type SmtpServerView = SmtpServer & { passwordSet: boolean };

type PasswordColumnName = 'password' | 'password_encrypted';
interface PasswordColumn { name: PasswordColumnName; maxLength: number | null }

// Migration 009 names the column `password_encrypted`; databases that started
// from the Obliview schema have `password`. Detected once, from the live table.
let passwordColumnPromise: Promise<PasswordColumn> | null = null;

function passwordColumn(): Promise<PasswordColumn> {
  if (!passwordColumnPromise) {
    passwordColumnPromise = (async () => {
      const info = await db('smtp_servers').columnInfo() as unknown as Record<string, { maxLength?: number | string | null }>;
      const name: PasswordColumnName = info.password ? 'password' : 'password_encrypted';
      const max = Number(info[name]?.maxLength);
      return { name, maxLength: Number.isFinite(max) && max > 0 ? max : null };
    })().catch((err) => {
      passwordColumnPromise = null; // retry on the next call
      throw err;
    });
  }
  return passwordColumnPromise;
}

function storedPassword(row: SmtpServerRow, col: PasswordColumn): string | null {
  const value = row[col.name];
  return typeof value === 'string' ? value : null;
}

function aad(id: number): string {
  return `smtp:${id}`;
}

/** The value to store for a new password: encrypted when a key is configured. */
function sealPassword(id: number, plain: string, col: PasswordColumn): string {
  const value = secretBox.isAvailable() ? secretBox.encryptString(plain, aad(id)) : plain;
  if (col.maxLength !== null && value.length > col.maxLength) {
    throw new AppError(400, 'SMTP password is too long');
  }
  return value;
}

function openPassword(row: SmtpServerRow, col: PasswordColumn): string {
  const stored = storedPassword(row, col);
  if (!stored) return '';
  return secretBox.decryptString(stored, aad(row.id));
}

function rowToServer(row: SmtpServerRow, col: PasswordColumn): SmtpServerView {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    fromAddress: row.from_address,
    passwordSet: !!storedPassword(row, col),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToRecord(row: SmtpServerRow, col: PasswordColumn): SmtpServerRecord {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    password: openPassword(row, col),
    from_address: row.from_address,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const smtpServerService = {
  async list(tenantId?: number): Promise<SmtpServerView[]> {
    const col = await passwordColumn();
    const query = db<SmtpServerRow>('smtp_servers').orderBy('name');
    if (tenantId !== undefined) {
      query.where({ tenant_id: tenantId });
    } else {
      query.whereNull('tenant_id');
    }
    const rows = await query;
    return rows.map((row) => rowToServer(row, col));
  },

  /**
   * Server-internal lookup by id (OTP / password-reset mail, channel
   * resolution), password decrypted. NOT tenant-gated: request handlers use
   * the tenant-scoped methods below.
   */
  async getById(id: number): Promise<SmtpServerRecord | null> {
    const col = await passwordColumn();
    const row = await db<SmtpServerRow>('smtp_servers').where({ id }).first();
    return row ? rowToRecord(row, col) : null;
  },

  async create(data: {
    name: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromAddress: string;
    tenantId?: number;
  }): Promise<SmtpServerView> {
    const col = await passwordColumn();
    // The AAD binds the ciphertext to the row id, known only after the insert.
    const row = await db.transaction(async (trx) => {
      const [inserted] = await trx<SmtpServerRow>('smtp_servers')
        .insert({
          name: data.name,
          host: data.host,
          port: data.port,
          secure: data.secure,
          username: data.username,
          [col.name]: '',
          from_address: data.fromAddress,
          tenant_id: data.tenantId ?? null,
        })
        .returning('*');
      const [updated] = await trx<SmtpServerRow>('smtp_servers')
        .where({ id: inserted.id })
        .update({ [col.name]: sealPassword(inserted.id, data.password, col) })
        .returning('*');
      return updated;
    });
    return rowToServer(row, col);
  },

  /** Updates a server of the tenant. An absent or empty password keeps the stored one. */
  async update(id: number, tenantId: number, data: Partial<{
    name: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromAddress: string;
  }>): Promise<SmtpServerView | null> {
    const col = await passwordColumn();
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.host !== undefined) update.host = data.host;
    if (data.port !== undefined) update.port = data.port;
    if (data.secure !== undefined) update.secure = data.secure;
    if (data.username !== undefined) update.username = data.username;
    if (data.password) update[col.name] = sealPassword(id, data.password, col);
    if (data.fromAddress !== undefined) update.from_address = data.fromAddress;

    const [row] = await db<SmtpServerRow>('smtp_servers')
      .where({ id, tenant_id: tenantId })
      .update(update)
      .returning('*');
    return row ? rowToServer(row, col) : null;
  },

  async delete(id: number, tenantId: number): Promise<boolean> {
    const count = await db('smtp_servers').where({ id, tenant_id: tenantId }).del();
    return count > 0;
  },

  /** Connection + authentication check of a server of the tenant. */
  async test(id: number, tenantId: number): Promise<void> {
    const col = await passwordColumn();
    const row = await db<SmtpServerRow>('smtp_servers').where({ id, tenant_id: tenantId }).first();
    if (!row) throw new AppError(404, 'SMTP server not found');
    const server = rowToRecord(row, col);

    const transport = nodemailer.createTransport({
      host: server.host,
      port: server.port,
      secure: server.secure,
      auth: { user: server.username, pass: server.password },
    });

    await transport.verify();
  },

  /**
   * Build a nodemailer transport config from a server row. With tenantId,
   * only a server of that tenant is returned (notification channels).
   */
  async getTransportConfig(id: number, tenantId?: number): Promise<{ host: string; port: number; secure: boolean; username: string; password: string; fromAddress: string } | null> {
    const col = await passwordColumn();
    const query = db<SmtpServerRow>('smtp_servers').where({ id });
    if (tenantId !== undefined) query.where({ tenant_id: tenantId });
    const stored = await query.first();
    if (!stored) return null;
    const row = rowToRecord(stored, col);
    return {
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      password: row.password,
      fromAddress: row.from_address,
    };
  },
};
