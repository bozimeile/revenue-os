CREATE TRIGGER audit_lead_status_after_update
AFTER UPDATE OF status ON leads
WHEN OLD.status <> NEW.status
BEGIN
    INSERT INTO audit_events (entity_type, entity_id, action, detail_json, created_at)
    VALUES (
        'lead',
        NEW.id,
        'status_changed',
        json_object('from', OLD.status, 'to', NEW.status),
        NEW.updated_at
    );
END;

CREATE TRIGGER require_contracted_lead_before_invoice
BEFORE INSERT ON invoices
WHEN NEW.lead_id IS NOT NULL
BEGIN
    SELECT CASE
        WHEN NOT EXISTS (
            SELECT 1
            FROM leads
            WHERE id = NEW.lead_id AND status = 'contracted'
        )
        THEN RAISE(ABORT, 'linked invoice requires a contracted lead')
    END;
END;

CREATE TRIGGER open_linked_lead_after_invoice
AFTER INSERT ON invoices
WHEN NEW.lead_id IS NOT NULL
BEGIN
    UPDATE leads
    SET status = 'invoice_open', updated_at = NEW.created_at
    WHERE id = NEW.lead_id AND status = 'contracted';
END;
