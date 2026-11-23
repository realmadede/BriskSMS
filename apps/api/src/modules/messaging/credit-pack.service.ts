import { randomUUID } from 'node:crypto';
import { BriskError } from '@brisksms/shared';
import { sql, SqlExecutor } from '@brisksms/db';

export interface CreditPackDto {
  id: string;
  code: string;
  name: string;
  credits: number;
  currency: string;
  amountCents: string;
  isActive: boolean;
  sortOrder: number;
}

export interface CreditPackInput {
  code: string;
  name: string;
  credits: number;
  currency: string;
  amountCents: bigint;
  isActive?: boolean;
  sortOrder?: number;
}

function toDto(row: Record<string, any>): CreditPackDto {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    credits: Number(row.credits),
    currency: String(row.currency),
    amountCents: String(row.amount_cents),
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order),
  };
}

function validate(input: CreditPackInput): void {
  if (!/^[A-Z0-9_]{2,40}$/.test(input.code)) {
    throw new BriskError('VALIDATION_ERROR', 'Pack code must be 2 to 40 characters: capital letters, digits or underscore.', 400);
  }
  if (!input.name.trim() || input.name.length > 100) {
    throw new BriskError('VALIDATION_ERROR', 'Pack name is required and at most 100 characters.', 400);
  }
  if (!Number.isInteger(input.credits) || input.credits <= 0 || input.credits > 100_000_000) {
    throw new BriskError('VALIDATION_ERROR', 'Credits must be a whole number above zero.', 400);
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new BriskError('VALIDATION_ERROR', 'Currency must be a three-letter code.', 400);
  }
  if (input.amountCents <= 0n) {
    throw new BriskError('VALIDATION_ERROR', 'A pack must have a price above zero.', 400);
  }
}

/** Fixed packs of prepaid SMS credits, configured by the platform admin. */
export class CreditPackService {
  /** Every pack for /nexus, or only the active ones a customer may buy. */
  async list(onlyActive: boolean, db: SqlExecutor = sql): Promise<CreditPackDto[]> {
    const rows = await db<Record<string, any>>`
      SELECT * FROM "credit_packs"
      WHERE (${onlyActive} = false OR "is_active" = true)
      ORDER BY "sort_order" ASC, "amount_cents" ASC
    `;
    return rows.map(toDto);
  }

  async getById(id: string, db: SqlExecutor = sql): Promise<CreditPackDto | null> {
    const rows = await db<Record<string, any>>`SELECT * FROM "credit_packs" WHERE "id" = ${id}::uuid`;
    return rows[0] ? toDto(rows[0]) : null;
  }

  async create(input: CreditPackInput): Promise<CreditPackDto> {
    validate(input);
    const exists = await sql`SELECT 1 FROM "credit_packs" WHERE "code" = ${input.code}`;
    if (exists.length > 0) {
      throw new BriskError('PACK_CODE_EXISTS', `A credit pack with code '${input.code}' already exists.`, 409);
    }
    const rows = await sql<Record<string, any>>`
      INSERT INTO "credit_packs" ("id", "code", "name", "credits", "currency", "amount_cents", "is_active", "sort_order")
      VALUES (${randomUUID()}, ${input.code}, ${input.name.trim()}, ${input.credits}, ${input.currency},
              ${input.amountCents.toString()}::bigint, ${input.isActive ?? true}, ${input.sortOrder ?? 0})
      RETURNING *
    `;
    return toDto(rows[0]!);
  }

  /** Editing a pack never changes a purchase that was already requested: those keep their own copy. */
  async update(id: string, input: CreditPackInput): Promise<{ before: CreditPackDto; after: CreditPackDto }> {
    validate(input);
    const before = await this.getById(id);
    if (!before) {
      throw new BriskError('NOT_FOUND', 'Credit pack not found.', 404);
    }
    const clash = await sql`SELECT 1 FROM "credit_packs" WHERE "code" = ${input.code} AND "id" <> ${id}::uuid`;
    if (clash.length > 0) {
      throw new BriskError('PACK_CODE_EXISTS', `A credit pack with code '${input.code}' already exists.`, 409);
    }
    const rows = await sql<Record<string, any>>`
      UPDATE "credit_packs" SET
        "code" = ${input.code}, "name" = ${input.name.trim()}, "credits" = ${input.credits},
        "currency" = ${input.currency}, "amount_cents" = ${input.amountCents.toString()}::bigint,
        "is_active" = ${input.isActive ?? before.isActive}, "sort_order" = ${input.sortOrder ?? before.sortOrder},
        "updated_at" = NOW()
      WHERE "id" = ${id}::uuid
      RETURNING *
    `;
    return { before, after: toDto(rows[0]!) };
  }
}

export const creditPackService = new CreditPackService();
