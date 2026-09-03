PRAGMA foreign_keys = ON;

CREATE TABLE leads (
    id               TEXT PRIMARY KEY,
    source           TEXT NOT NULL,
    external_id      TEXT NOT NULL,
    evidence_url     TEXT NOT NULL,
    title            TEXT NOT NULL,
    description      TEXT NOT NULL,
    author           TEXT NOT NULL,
    author_type      TEXT NOT NULL,
    labels_json      TEXT NOT NULL,
    score            INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
    score_reasons_json TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN (
        'new', 'qualified', 'drafted', 'approved', 'sent', 'replied', 'proposal',
        'contracted', 'invoice_open', 'paid', 'delivering', 'delivered', 'closed',
        'disqualified', 'no_response', 'lost', 'expired'
    )),
    discovered_at    TEXT NOT NULL,
    last_verified_at TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (source, external_id)
);

CREATE INDEX idx_leads_status_score ON leads (status, score DESC, last_verified_at DESC);

CREATE TABLE invoices (
    id                TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL,
    lead_id           TEXT,
    offer_code        TEXT NOT NULL,
    amount_usd_cents  INTEGER NOT NULL CHECK (amount_usd_cents > 0),
    chain_id          INTEGER NOT NULL CHECK (chain_id > 0),
    token_symbol      TEXT NOT NULL,
    token_address     TEXT NOT NULL,
    token_decimals    INTEGER NOT NULL,
    amount_atomic     TEXT NOT NULL,
    payer_address     TEXT NOT NULL,
    recipient_address TEXT NOT NULL,
    min_confirmations INTEGER NOT NULL CHECK (min_confirmations > 0),
    status            TEXT NOT NULL CHECK (status IN ('open', 'paid', 'expired')),
    created_at        TEXT NOT NULL,
    expires_at        TEXT NOT NULL,
    paid_at           TEXT,
    paid_payment_id   TEXT UNIQUE,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
);

CREATE INDEX idx_invoices_status_expiry ON invoices (status, expires_at);

CREATE TABLE payments (
    id                TEXT PRIMARY KEY,
    invoice_id        TEXT NOT NULL UNIQUE,
    chain_id          INTEGER NOT NULL,
    token_address     TEXT NOT NULL,
    amount_atomic     TEXT NOT NULL,
    amount_usd_cents  INTEGER NOT NULL,
    tx_hash           TEXT NOT NULL,
    block_hash        TEXT NOT NULL,
    block_number      TEXT NOT NULL,
    log_index         TEXT NOT NULL,
    confirmations     INTEGER NOT NULL,
    rpc_agreement     INTEGER NOT NULL,
    received_at       TEXT NOT NULL,
    UNIQUE (chain_id, tx_hash, log_index),
    FOREIGN KEY (invoice_id) REFERENCES invoices(id)
);

CREATE INDEX idx_payments_received_at ON payments (received_at DESC);

CREATE TABLE allocations (
    payment_id        TEXT NOT NULL,
    bucket            TEXT NOT NULL,
    basis_points      INTEGER NOT NULL CHECK (basis_points > 0),
    usd_cents         INTEGER NOT NULL CHECK (usd_cents >= 0),
    PRIMARY KEY (payment_id, bucket),
    FOREIGN KEY (payment_id) REFERENCES payments(id)
);

CREATE TABLE audit_events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type       TEXT NOT NULL,
    entity_id         TEXT NOT NULL,
    action            TEXT NOT NULL,
    detail_json       TEXT NOT NULL,
    created_at        TEXT NOT NULL
);

CREATE INDEX idx_audit_events_entity ON audit_events (entity_type, entity_id, id DESC);
