import { assertLeadTransition } from "./lifecycle.js";

export class StoreConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreConflictError";
    this.code = code;
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapLead(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    evidenceUrl: row.evidence_url,
    title: row.title,
    description: row.description,
    author: row.author,
    authorType: row.author_type,
    labels: parseJsonArray(row.labels_json),
    score: row.score,
    scoreReasons: parseJsonArray(row.score_reasons_json),
    status: row.status,
    discoveredAt: row.discovered_at,
    lastVerifiedAt: row.last_verified_at,
    updatedAt: row.updated_at,
  };
}

function mapInvoice(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestFingerprint: row.request_fingerprint,
    leadId: row.lead_id,
    offerCode: row.offer_code,
    amountUsdCents: row.amount_usd_cents,
    chainId: row.chain_id,
    tokenSymbol: row.token_symbol,
    tokenAddress: row.token_address,
    tokenDecimals: row.token_decimals,
    amountAtomic: row.amount_atomic,
    payerAddress: row.payer_address,
    recipientAddress: row.recipient_address,
    minConfirmations: row.min_confirmations,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    paidPaymentId: row.paid_payment_id,
  };
}

export class D1Store {
  constructor(database) {
    if (!database || typeof database.prepare !== "function" || typeof database.batch !== "function") {
      throw new TypeError("D1-compatible database is required");
    }
    this.database = database;
  }

  async getLead(id) {
    const row = await this.database.prepare("SELECT * FROM leads WHERE id = ?1").bind(id).first();
    return mapLead(row);
  }

  async listLeads({ status = null, limit = 50 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new TypeError("lead list limit must be between 1 and 100");
    }
    const response = status
      ? await this.database
          .prepare(
            "SELECT * FROM leads WHERE status = ?1 ORDER BY score DESC, last_verified_at DESC LIMIT ?2",
          )
          .bind(status, limit)
          .all()
      : await this.database
          .prepare("SELECT * FROM leads ORDER BY score DESC, last_verified_at DESC LIMIT ?1")
          .bind(limit)
          .all();
    return response.results.map(mapLead);
  }

  async upsertLead(lead) {
    const id = `${lead.source}:${lead.externalId}`;
    const existed = (await this.getLead(id)) !== null;
    const timestamp = lead.lastVerifiedAt;
    await this.database
      .prepare(
        `INSERT INTO leads (
          id, source, external_id, evidence_url, title, description, author, author_type,
          labels_json, score, score_reasons_json, status, discovered_at, last_verified_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        ON CONFLICT(source, external_id) DO UPDATE SET
          evidence_url = excluded.evidence_url,
          title = excluded.title,
          description = excluded.description,
          author = excluded.author,
          author_type = excluded.author_type,
          labels_json = excluded.labels_json,
          score = excluded.score,
          score_reasons_json = excluded.score_reasons_json,
          last_verified_at = excluded.last_verified_at,
          updated_at = excluded.updated_at`,
      )
      .bind(
        id,
        lead.source,
        lead.externalId,
        lead.evidenceUrl,
        lead.title,
        lead.description,
        lead.author,
        lead.authorType,
        JSON.stringify(lead.labels),
        lead.score,
        JSON.stringify(lead.scoreReasons),
        lead.status,
        lead.discoveredAt,
        lead.lastVerifiedAt,
        timestamp,
      )
      .run();
    return existed ? "updated" : "inserted";
  }

  async transitionLead(id, expectedStatus, nextStatus, changedAt) {
    assertLeadTransition(expectedStatus, nextStatus);
    const result = await this.database
      .prepare("UPDATE leads SET status = ?1, updated_at = ?2 WHERE id = ?3 AND status = ?4")
      .bind(nextStatus, changedAt, id, expectedStatus)
      .run();
    if (result.meta.changes !== 1) {
      throw new StoreConflictError("LEAD_STATE_CONFLICT", "lead status changed or lead does not exist");
    }
    return this.getLead(id);
  }

  async getInvoice(id) {
    const row = await this.database.prepare("SELECT * FROM invoices WHERE id = ?1").bind(id).first();
    return mapInvoice(row);
  }

  async createInvoice(invoice) {
    const existing = await this.getInvoice(invoice.id);
    if (existing) {
      if (existing.requestFingerprint !== invoice.requestFingerprint) {
        throw new StoreConflictError("IDEMPOTENCY_CONFLICT", "idempotency key was reused with different invoice data");
      }
      return { invoice: existing, created: false };
    }

    try {
      await this.database
        .prepare(
          `INSERT INTO invoices (
            id, request_fingerprint, lead_id, offer_code, amount_usd_cents, chain_id,
            token_symbol, token_address, token_decimals, amount_atomic, payer_address,
            recipient_address, min_confirmations, status, created_at, expires_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
        )
        .bind(
          invoice.id,
          invoice.requestFingerprint,
          invoice.leadId,
          invoice.offerCode,
          invoice.amountUsdCents,
          invoice.chainId,
          invoice.tokenSymbol,
          invoice.tokenAddress,
          invoice.tokenDecimals,
          invoice.amountAtomic,
          invoice.payerAddress,
          invoice.recipientAddress,
          invoice.minConfirmations,
          invoice.status,
          invoice.createdAt,
          invoice.expiresAt,
        )
        .run();
    } catch (error) {
      const raced = await this.getInvoice(invoice.id);
      if (raced?.requestFingerprint === invoice.requestFingerprint) {
        return { invoice: raced, created: false };
      }
      throw new StoreConflictError("INVOICE_CREATE_CONFLICT", "invoice could not be created");
    }

    return { invoice: await this.getInvoice(invoice.id), created: true };
  }

  async markInvoiceExpired(id, expiredAt) {
    const result = await this.database
      .prepare("UPDATE invoices SET status = 'expired' WHERE id = ?1 AND status = 'open' AND expires_at <= ?2")
      .bind(id, expiredAt)
      .run();
    if (result.meta.changes !== 1) {
      throw new StoreConflictError("INVOICE_STATE_CONFLICT", "invoice cannot be expired from its current state");
    }
    return this.getInvoice(id);
  }

  async markInvoicePaid({ invoiceId, verification, allocations, receivedAt }) {
    const invoice = await this.getInvoice(invoiceId);
    if (!invoice || invoice.status !== "open") {
      throw new StoreConflictError("INVOICE_STATE_CONFLICT", "invoice is not open");
    }
    const allocationTotal = allocations.reduce((sum, item) => sum + item.usdCents, 0);
    const bpsTotal = allocations.reduce((sum, item) => sum + item.bps, 0);
    if (allocationTotal !== invoice.amountUsdCents || bpsTotal !== 10_000) {
      throw new TypeError("payment allocation does not reconcile to the invoice");
    }

    const paymentId = `pay_${invoice.chainId}_${verification.transactionHash.slice(2)}_${verification.logIndex}`;
    const statements = [
      this.database
        .prepare(
          `INSERT INTO payments (
            id, invoice_id, chain_id, token_address, amount_atomic, amount_usd_cents,
            tx_hash, block_hash, block_number, log_index, confirmations, rpc_agreement, received_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .bind(
          paymentId,
          invoice.id,
          invoice.chainId,
          invoice.tokenAddress,
          invoice.amountAtomic,
          invoice.amountUsdCents,
          verification.transactionHash,
          verification.blockHash,
          verification.blockNumber.toString(),
          verification.logIndex.toString(),
          Number(verification.confirmations),
          verification.rpcAgreement,
          receivedAt,
        ),
      ...allocations.map((item) =>
        this.database
          .prepare("INSERT INTO allocations (payment_id, bucket, basis_points, usd_cents) VALUES (?1, ?2, ?3, ?4)")
          .bind(paymentId, item.key, item.bps, item.usdCents),
      ),
      this.database
        .prepare(
          "UPDATE invoices SET status = 'paid', paid_at = ?1, paid_payment_id = ?2 WHERE id = ?3 AND status = 'open'",
        )
        .bind(receivedAt, paymentId, invoice.id),
      this.database
        .prepare(
          "INSERT INTO audit_events (entity_type, entity_id, action, detail_json, created_at) VALUES ('invoice', ?1, 'payment_confirmed', ?2, ?3)",
        )
        .bind(
          invoice.id,
          JSON.stringify({
            paymentId,
            transactionHash: verification.transactionHash,
            blockNumber: verification.blockNumber.toString(),
            logIndex: verification.logIndex.toString(),
          }),
          receivedAt,
        ),
    ];
    if (invoice.leadId) {
      statements.push(
        this.database
          .prepare("UPDATE leads SET status = 'paid', updated_at = ?1 WHERE id = ?2 AND status = 'invoice_open'")
          .bind(receivedAt, invoice.leadId),
      );
    }

    try {
      await this.database.batch(statements);
    } catch {
      throw new StoreConflictError("PAYMENT_CONFLICT", "payment or transfer log has already been recorded");
    }
    return this.getInvoice(invoice.id);
  }

  async getPaymentAllocations(paymentId) {
    const response = await this.database
      .prepare(
        "SELECT bucket, basis_points, usd_cents FROM allocations WHERE payment_id = ?1 ORDER BY bucket ASC",
      )
      .bind(paymentId)
      .all();
    return response.results.map((row) => ({
      key: row.bucket,
      bps: row.basis_points,
      usdCents: row.usd_cents,
    }));
  }

  async getRevenueSummary() {
    const [row, allocationRows] = await Promise.all([
      this.database
        .prepare(
          "SELECT COALESCE(SUM(amount_usd_cents), 0) AS received_usd_cents, COUNT(*) AS payments FROM payments",
        )
        .first(),
      this.database
        .prepare(
          "SELECT bucket, SUM(usd_cents) AS usd_cents FROM allocations GROUP BY bucket ORDER BY bucket ASC",
        )
        .all(),
    ]);
    return {
      receivedUsdCents: Number(row.received_usd_cents),
      payments: Number(row.payments),
      allocations: allocationRows.results.map((allocation) => ({
        key: allocation.bucket,
        usdCents: Number(allocation.usd_cents),
      })),
    };
  }
}
