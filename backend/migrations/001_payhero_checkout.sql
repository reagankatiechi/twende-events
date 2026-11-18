-- One-time migration for PayHero checkout metadata and fulfillment.
-- Existing Orders rows remain valid because external_reference/payhero values are nullable.
ALTER TABLE Orders
    ADD COLUMN external_reference VARCHAR(100) NULL,
    ADD COLUMN payhero_reference VARCHAR(120) NULL,
    ADD COLUMN payhero_checkout_request_id VARCHAR(120) NULL,
    ADD COLUMN tier_id INT NULL,
    ADD COLUMN quantity INT NOT NULL DEFAULT 1,
    ADD COLUMN attendee_name VARCHAR(255) NULL,
    ADD COLUMN attendee_email VARCHAR(255) NULL,
    ADD COLUMN payment_failure_reason TEXT NULL,
    ADD UNIQUE KEY uq_orders_external_reference (external_reference),
    ADD KEY idx_orders_tier_payment_created (tier_id, payment_status, created_at);
