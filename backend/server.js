const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();

const app = express();
const multer = require('multer');
const path = require('path');
const { randomUUID, createHmac, timingSafeEqual } = require('crypto');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Allow the configured GitHub Pages/static frontend origin(s); default to all origins for easy setup.
const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : true;
app.use(cors({ origin: corsOrigins }));

// Allow the frontend to access uploaded images, including cross-origin canvas reads.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Keep poster uploads in memory so new files can be streamed to Cloudinary.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('image/')) {
            return cb(null, true);
        }
        cb(new Error('Only image files are allowed'));
    }
});

function uploadPosterToCloudinary(buffer) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder: 'twende-events/posters', resource_type: 'image' },
            (error, result) => {
                if (error) return reject(error);
                if (!result || !result.secure_url) {
                    return reject(new Error('Cloudinary did not return a secure poster URL'));
                }
                resolve(result.secure_url);
            }
        );
        stream.end(buffer);
    });
}

// Middleware
app.use(express.json()); // Allows us to parse JSON data from the frontend

// Lightweight endpoints for Render health checks and uptime monitors.
app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
// Database Connection Pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'defaultdb',
    ssl: {
        rejectUnauthorized: false
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Adds payment/ticket columns required by checkout without changing columns
// that already exist in an active deployment.
async function ensurePaymentSchema() {
    const databaseName = process.env.DB_NAME || 'defaultdb';
    const connection = await pool.getConnection();
    try {
        const tableColumns = new Map();
        for (const tableName of ['Orders', 'Purchased_Tickets', 'Ticket_Tiers']) {
            const [columns] = await connection.query(
                `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_KEY
                 FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
                [databaseName, tableName]
            );
            tableColumns.set(tableName, columns);
        }

        const definitions = {
            Orders: {
                order_id: 'BIGINT NOT NULL AUTO_INCREMENT',
                user_id: 'INT NULL',
                event_id: 'INT NULL',
                total_amount: 'DECIMAL(12,2) NOT NULL DEFAULT 0',
                tier_id: 'INT NULL',
                quantity: 'INT NOT NULL DEFAULT 1',
                checkout_phone: 'VARCHAR(32) NULL',
                phone_number: 'VARCHAR(32) NULL',
                external_reference: 'VARCHAR(100) NULL',
                payhero_reference: 'VARCHAR(100) NULL',
                payhero_checkout_request_id: 'VARCHAR(100) NULL',
                mpesa_receipt_number: 'VARCHAR(100) NULL',
                payment_status: "VARCHAR(32) NOT NULL DEFAULT 'pending'",
                failure_reason: 'TEXT NULL',
                payment_failure_reason: 'TEXT NULL',
                attendee_name: 'VARCHAR(255) NULL',
                attendee_email: 'VARCHAR(255) NULL',
                created_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
                updated_at: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
            },
            Purchased_Tickets: {
                ticket_id: 'BIGINT NOT NULL AUTO_INCREMENT',
                order_id: 'INT NULL',
                user_id: 'INT NULL',
                event_id: 'INT NULL',
                tier_id: 'INT NULL',
                ticket_code: 'VARCHAR(100) NULL',
                qr_code_data: 'TEXT NULL',
                attendee_name: 'VARCHAR(255) NULL',
                status: "VARCHAR(32) NOT NULL DEFAULT 'valid'",
                purchase_date: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP'
            },
            Ticket_Tiers: {
                tier_id: 'INT NOT NULL AUTO_INCREMENT',
                event_id: 'INT NULL',
                tier_name: 'VARCHAR(255) NULL',
                price: 'DECIMAL(12,2) NOT NULL DEFAULT 0',
                capacity: 'INT NULL',
                quantity_sold: 'INT NOT NULL DEFAULT 0'
            }
        };

        for (const [tableName, tableDefinitions] of Object.entries(definitions)) {
            let columns = tableColumns.get(tableName) || [];
            const existingNames = new Set(columns.map((column) => column.COLUMN_NAME));
            for (const [columnName, definition] of Object.entries(tableDefinitions)) {
                if (existingNames.has(columnName)) continue;
                let addDefinition = definition;
                if (definition.includes('AUTO_INCREMENT')) {
                    const hasPrimaryKey = columns.some((column) => column.COLUMN_KEY === 'PRI');
                    addDefinition += hasPrimaryKey ? ' UNIQUE' : ' PRIMARY KEY';
                }
                await connection.query(
                    `ALTER TABLE ?? ADD COLUMN ?? ${addDefinition}`,
                    [tableName, columnName]
                );
                console.log(`[schema] Added ${tableName}.${columnName}`);
                columns = [...columns, {
                    COLUMN_NAME: columnName,
                    IS_NULLABLE: /\bNULL\b/.test(definition) && !/NOT NULL/.test(definition) ? 'YES' : 'NO',
                    COLUMN_KEY: definition.includes('AUTO_INCREMENT') && !columns.some((column) => column.COLUMN_KEY === 'PRI') ? 'PRI' : ''
                }];
                existingNames.add(columnName);
            }

            if (tableName === 'Orders') {
                const userIdColumn = columns.find((column) => column.COLUMN_NAME === 'user_id');
                if (userIdColumn && userIdColumn.IS_NULLABLE === 'NO') {
                    await connection.query('ALTER TABLE `Orders` MODIFY COLUMN `user_id` INT NULL');
                    console.log('[schema] Updated Orders.user_id to allow NULL');
                }
                // The deployed schema may define this as an ENUM without a paid value.
                // Normalize it on every startup before payment routes can update orders.
                await connection.query("ALTER TABLE `Orders` MODIFY COLUMN `payment_status` VARCHAR(32) NOT NULL DEFAULT 'pending'");
                console.log('[schema] Ensured Orders.payment_status accepts payment states');
            }
        }
    } finally {
        connection.release();
    }
}

// Admin passcode tokens are HMAC-signed and expire after one work session.
const getAdminPasscode = () => process.env.ADMIN_PASSCODE || 'twendeevents.co.ke';
function createAdminToken() {
    const payload = Buffer.from(JSON.stringify({ role: 'admin', exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60 })).toString('base64url');
    const signature = createHmac('sha256', getAdminPasscode()).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}
function isValidAdminToken(token) {
    if (typeof token !== 'string') return false;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return false;
    const expected = createHmac('sha256', getAdminPasscode()).update(payload).digest();
    let supplied;
    try { supplied = Buffer.from(signature, 'base64url'); } catch (_) { return false; }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return claims.role === 'admin' && Number(claims.exp) > Math.floor(Date.now() / 1000);
    } catch (_) { return false; }
}
const getUserTokenSecret = () => process.env.AUTH_TOKEN_SECRET || getAdminPasscode();
function createUserToken(user) {
    const payload = Buffer.from(JSON.stringify({
        user_id: Number(user.user_id),
        email: String(user.email || '').toLowerCase(),
        role: String(user.role || 'user').toLowerCase(),
        exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
    })).toString('base64url');
    const signature = createHmac('sha256', getUserTokenSecret()).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}
function verifyUserToken(token) {
    if (typeof token !== 'string') return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = createHmac('sha256', getUserTokenSecret()).update(payload).digest();
    let supplied;
    try { supplied = Buffer.from(signature, 'base64url'); } catch (_) { return null; }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    try {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!Number.isSafeInteger(Number(claims.user_id)) || Number(claims.user_id) < 1
            || !claims.email || Number(claims.exp) <= Math.floor(Date.now() / 1000)) return null;
        return { ...claims, user_id: Number(claims.user_id) };
    } catch (_) { return null; }
}
function authenticateUser(req, res, next) {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const user = verifyUserToken(bearer?.[1]);
    if (!user) return res.status(401).json({ error: 'Please sign in again to continue.' });
    req.authUser = user;
    req.user = user;
    return next();
}
function requireAdminAccess(req, res, next) {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const token = req.get('x-admin-token') || (bearer && bearer[1]);
    if (!isValidAdminToken(token)) {
        return res.status(401).json({ success: false, message: 'Admin access required.' });
    }
    req.admin = { role: 'admin' };
    return next();
}

app.post('/api/admin/verify-passcode', (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password !== getAdminPasscode()) {
        return res.status(401).json({ success: false, message: 'Incorrect admin password' });
    }
    return res.status(200).json({ success: true, adminToken: createAdminToken() });
});

// All admin API routes require a verified passcode token (x-admin-token or Bearer).
app.use('/api/admin', requireAdminAccess);

function payHeroAuthorization() {
    const username = process.env.PAYHERO_API_USERNAME;
    const password = process.env.PAYHERO_API_PASSWORD;
    if (username && password) return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    if (process.env.PAYHERO_AUTH_TOKEN) return process.env.PAYHERO_AUTH_TOKEN;
    throw new Error('PayHero API credentials are not configured');
}

async function payHeroRequest(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                Authorization: payHeroAuthorization(),
                Accept: 'application/json',
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...options.headers
            }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || (options.method !== 'GET' && payload.success === false)) {
            const error = new Error(payload.message || payload.error || payload.ResultDesc || `PayHero request failed (${response.status})`);
            error.status = response.status;
            error.payHeroResponse = payload;
            throw error;
        }
        return payload;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchPayHeroTransactionStatus(reference) {
    const query = new URLSearchParams({ reference: String(reference) });
    return payHeroRequest(`https://backend.payhero.co.ke/api/v2/transaction-status?${query}`, { method: 'GET' });
}

function readPayHeroStatus(data) {
    const nested = data?.response && typeof data.response === 'object' ? data.response : {};
    const statuses = [data?.status, data?.Status, nested.status, nested.Status]
        .filter((value) => value != null && String(value).trim())
        .map((value) => String(value).trim().toUpperCase());
    const resultCodes = [data?.ResultCode, data?.resultCode, data?.result_code, nested.ResultCode, nested.resultCode, nested.result_code];
    const paid = statuses.some((status) => status === 'SUCCESS' || status === 'COMPLETED')
        || resultCodes.some((code) => code != null && String(code).trim() !== '' && Number(code) === 0);
    const failed = statuses.some((status) => ['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(status));
    const receipt = data?.provider_reference || data?.third_party_reference || data?.MpesaReceiptNumber || data?.mpesa_receipt_number
        || nested.provider_reference || nested.third_party_reference || nested.MpesaReceiptNumber || nested.mpesa_receipt_number || null;
    const failureReason = data?.ResultDesc || data?.result_desc || nested.ResultDesc || nested.result_desc || null;
    return { paid, failed, statuses, receipt, failureReason };
}

function lastNinePhoneDigits(value) {
    const digits = String(value || '').replace(/\D/g, '');
    return digits.length >= 9 ? digits.slice(-9) : '';
}

async function reconcilePendingOrdersForUser(user) {
    const userId = Number(user?.user_id ?? user?.id);
    if (!Number.isSafeInteger(userId) || userId < 1) return { checked: 0, reconciled: 0 };

    const [users] = await pool.query(
        `SELECT user_id, phone_number, email FROM Users WHERE user_id = ? LIMIT 1`,
        [userId]
    );
    const account = users[0];
    if (!account) return { checked: 0, reconciled: 0 };
    const lastNine = lastNinePhoneDigits(account.phone_number || user.phone_number);
    const phonePattern = lastNine ? `%${lastNine}` : '__NO_PHONE_MATCH__';
    const [orders] = await pool.query(
        `SELECT o.order_id, o.user_id, o.external_reference, o.payhero_reference,
                o.payhero_checkout_request_id, o.payment_status, o.mpesa_receipt_number
         FROM Orders o
         WHERE (
             (o.payment_status = 'pending' AND o.created_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR))
             OR (o.payment_status = 'paid' AND NOT EXISTS (
                SELECT 1 FROM Purchased_Tickets p
                WHERE p.order_id = o.order_id
                   OR EXISTS (SELECT 1 FROM Tickets t WHERE t.order_id = o.order_id AND t.ticket_code = p.ticket_code)
             ))
           )
           AND (o.user_id = ? OR (o.user_id IS NULL AND (
                RIGHT(REPLACE(COALESCE(NULLIF(o.phone_number, ''), o.checkout_phone), '+', ''), 9) = ?
                OR o.phone_number LIKE ? OR o.checkout_phone LIKE ?
           )))
         ORDER BY o.created_at ASC`,
        [userId, lastNine || '__NO_PHONE_MATCH__', phonePattern, phonePattern]
    );

    let reconciled = 0;
    for (const order of orders) {
        try {
            let receipt = order.mpesa_receipt_number || null;
            if (String(order.payment_status).toLowerCase() !== 'paid') {
                const reference = order.payhero_reference || order.payhero_checkout_request_id || order.external_reference;
                if (!reference) continue;
                const data = await fetchPayHeroTransactionStatus(reference);
                console.log('[PayHero Status Check]', JSON.stringify(data));
                const status = readPayHeroStatus(data);
                if (!status.paid) continue;
                receipt = status.receipt || receipt;
            }
            if (order.user_id == null) {
                await pool.query(
                    `UPDATE Orders SET user_id = ? WHERE order_id = ? AND user_id IS NULL`,
                    [userId, order.order_id]
                );
            }
            const result = await fulfillPaidOrder(order.order_id, receipt);
            if (result.status === 'paid') reconciled += 1;
        } catch (error) {
            console.error(`[reconcile] User ${userId}, order ${order.order_id} could not be reconciled:`, error);
        }
    }
    return { checked: orders.length, reconciled };
}

function normalizeKenyanPhone(phone) {
    const input = String(phone || '').trim();
    const digits = input.replace(/\D/g, '');
    let normalized;
    if (/^0[17]\d{8}$/.test(digits)) normalized = `254${digits.slice(1)}`;
    else if (/^[17]\d{8}$/.test(digits)) normalized = `254${digits}`;
    else if (/^254[17]\d{8}$/.test(digits)) normalized = digits;

    if (normalized && /^254[17]\d{8}$/.test(normalized)) return normalized;
    throw new Error('Enter a valid Kenyan mobile number, such as 0712345678, 0112345678, or +254712345678.');
}

async function getOrderTicketCodes(connection, orderId) {
    const [tickets] = await connection.query(
        `SELECT p.ticket_code
         FROM Purchased_Tickets p
         LEFT JOIN Tickets t ON p.ticket_code = t.ticket_code
         WHERE p.order_id = ? OR t.order_id = ?
         ORDER BY COALESCE(t.ticket_id, p.ticket_id) ASC`,
        [orderId, orderId]
    );
    return tickets.map((ticket) => ticket.ticket_code);
}

async function insertPurchasedTicket(connection, order, ticketCode, ticketColumns) {
    const valuesByColumn = {
        order_id: order.order_id,
        user_id: order.user_id,
        event_id: order.event_id,
        tier_id: order.tier_id,
        ticket_code: ticketCode,
        qr_code_data: ticketCode,
        attendee_name: order.attendee_name || 'Guest',
        status: 'valid',
        purchase_date: new Date(),
        created_at: new Date(),
        updated_at: new Date()
    };
    const availableColumns = ticketColumns.filter((column) => Object.hasOwn(valuesByColumn, column.COLUMN_NAME));
    const requiredWithoutValue = ticketColumns.filter((column) =>
        column.IS_NULLABLE === 'NO'
        && column.COLUMN_DEFAULT == null
        && !String(column.EXTRA || '').toLowerCase().includes('auto_increment')
        && !String(column.EXTRA || '').toLowerCase().includes('generated')
        && !Object.hasOwn(valuesByColumn, column.COLUMN_NAME)
    );
    if (requiredWithoutValue.length) {
        throw new Error(`Purchased_Tickets has required columns without fulfillment values: ${requiredWithoutValue.map((column) => column.COLUMN_NAME).join(', ')}`);
    }
    if (!availableColumns.some((column) => column.COLUMN_NAME === 'ticket_code')) {
        throw new Error('Purchased_Tickets.ticket_code is missing; cannot create a gate-scannable ticket.');
    }

    const names = availableColumns.map((column) => column.COLUMN_NAME);
    const placeholders = names.map(() => '?').join(', ');
    const quotedNames = names.map((name) => `\`${name.replace(/`/g, '``')}\``).join(', ');
    const parameters = availableColumns.map((column) => {
        const value = valuesByColumn[column.COLUMN_NAME];
        return String(column.DATA_TYPE || '').toLowerCase() === 'json' && column.COLUMN_NAME === 'qr_code_data'
            ? JSON.stringify({ ticket_code: ticketCode })
            : value;
    });
    await connection.query(`INSERT INTO Purchased_Tickets (${quotedNames}) VALUES (${placeholders})`, parameters);
}

// A locked order row makes callbacks and status polling share one idempotent issuer.
async function fulfillPaidOrder(orderId, mpesaReceipt = null) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [orders] = await connection.query(
            `SELECT order_id, user_id, event_id, total_amount, tier_id, quantity, payment_status,
                    attendee_name,
                    mpesa_receipt_number
             FROM Orders WHERE order_id = ? LIMIT 1 FOR UPDATE`,
            [orderId]
        );
        if (!orders.length) {
            await connection.rollback();
            return { found: false, status: 'not_found', tickets: [] };
        }

        const order = orders[0];
        const alreadyPaid = String(order.payment_status).toLowerCase() === 'paid';
        const existingTicketCodes = alreadyPaid ? await getOrderTicketCodes(connection, order.order_id) : [];
        const [[purchasedCountRow]] = await connection.query(
            `SELECT COUNT(*) AS ticket_count FROM Purchased_Tickets WHERE order_id = ?`,
            [order.order_id]
        );
        const purchasedTicketCount = Number(purchasedCountRow?.ticket_count || 0);
        const ticketQuantity = Number(order.quantity || 1);
        if (!Number.isSafeInteger(ticketQuantity) || ticketQuantity < 1) {
            throw new Error(`Order ${order.order_id} has an invalid ticket quantity`);
        }
        if (alreadyPaid && Math.max(purchasedTicketCount, existingTicketCodes.length) >= ticketQuantity) {
            await connection.commit();
            return { found: true, status: 'paid', mpesaReceipt: order.mpesa_receipt_number || mpesaReceipt || null, tickets: existingTicketCodes };
        }

        const [tierRows] = await connection.query(
            `SELECT tier_id, event_id FROM Ticket_Tiers WHERE tier_id = ? LIMIT 1 FOR UPDATE`,
            [order.tier_id]
        );
        if (!tierRows.length) throw new Error('The ticket tier for this paid order no longer exists');
        order.event_id = order.event_id || tierRows[0].event_id;
        if (!alreadyPaid) {
            await connection.query(
                `UPDATE Ticket_Tiers SET quantity_sold = COALESCE(quantity_sold, 0) + ? WHERE tier_id = ?`,
                [ticketQuantity, order.tier_id]
            );
        }
        await connection.query(
            `UPDATE Orders
             SET payment_status = 'paid', mpesa_receipt_number = COALESCE(?, mpesa_receipt_number),
                 payment_failure_reason = NULL, failure_reason = NULL
             WHERE order_id = ?`,
            [mpesaReceipt, order.order_id]
        );

        const [ticketColumns] = await connection.query(
            `SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, DATA_TYPE
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'Purchased_Tickets'`,
            [process.env.DB_NAME || 'defaultdb']
        );
        const ticketCodes = [...existingTicketCodes];
        const existingTicketCount = Math.max(purchasedTicketCount, existingTicketCodes.length);
        const missingTicketCount = Math.max(0, ticketQuantity - existingTicketCount);
        for (let index = 0; index < missingTicketCount; index += 1) {
            const ticketCode = randomUUID();
            ticketCodes.push(ticketCode);
            await insertPurchasedTicket(connection, order, ticketCode, ticketColumns);
            await connection.query(
                `INSERT INTO Tickets (order_id, tier_id, user_id, ticket_code, is_scanned, created_at) VALUES (?, ?, ?, ?, 0, NOW())`,
                [order.order_id, order.tier_id, order.user_id, ticketCode]
            );
        }
        await connection.commit();
        return { found: true, status: 'paid', mpesaReceipt: mpesaReceipt || order.mpesa_receipt_number || null, tickets: ticketCodes };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function markOrderFailed(orderIdentifier, reason) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [orders] = await connection.query(
            `SELECT order_id, payment_status FROM Orders
             WHERE external_reference = ? OR order_id = ? LIMIT 1 FOR UPDATE`,
            [String(orderIdentifier), /^\d+$/.test(String(orderIdentifier)) ? Number(orderIdentifier) : null]
        );
        if (!orders.length) {
            await connection.rollback();
            return { found: false, status: 'not_found' };
        }
        if (String(orders[0].payment_status).toLowerCase() === 'paid') {
            await connection.commit();
            return { found: true, status: 'paid' };
        }
        await connection.query(
            `UPDATE Orders SET payment_status = 'failed', payment_failure_reason = ?, failure_reason = ? WHERE order_id = ?`,
            [reason, reason, orders[0].order_id]
        );
        await connection.commit();
        return { found: true, status: 'failed' };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

app.post('/api/payments/stk-push', authenticateUser, async (req, res) => {
    const {
        user_id: rawUserId, event_id: rawEventId, tier_id: rawTierId, quantity: rawQuantity,
        attendee_name: rawAttendeeName, attendee_email: rawAttendeeEmail, email: rawEmail, phone_number: rawPhone
    } = req.body || {};
    const userId = req.authUser.user_id;
    if (rawUserId != null && Number(rawUserId) !== userId) {
        return res.status(403).json({ error: 'The signed-in account does not match this checkout.' });
    }
    const eventId = Number(rawEventId);
    const tierId = Number(rawTierId);
    const quantity = Number(rawQuantity);
    const attendeeName = String(rawAttendeeName || '').trim();
    const attendeeEmail = String(req.authUser.email || rawAttendeeEmail || rawEmail || '').trim().toLowerCase();

    if (![userId, eventId, tierId].every((value) => Number.isSafeInteger(value) && value > 0)
        || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10
        || !attendeeName || attendeeName.length > 255
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendeeEmail)) {
        return res.status(400).json({ error: 'Provide a valid user, event, tier, quantity (1–10), attendee name, and email.' });
    }
    let phoneNumber;
    try {
        phoneNumber = normalizeKenyanPhone(rawPhone);
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    const channelId = Number(process.env.PAYHERO_CHANNEL_ID);
    if (!Number.isSafeInteger(channelId) || channelId <= 0 || !process.env.PAYHERO_CALLBACK_URL) {
        return res.status(503).json({ error: 'PayHero channel and callback configuration are incomplete.' });
    }

    const connection = await pool.getConnection();
    let order;
    try {
        await connection.beginTransaction();
        const [users] = await connection.query(`SELECT user_id FROM Users WHERE user_id = ? LIMIT 1`, [userId]);
        if (!users.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Account not found. Please sign in again.' });
        }
        const [tiers] = await connection.query(
            `SELECT tt.tier_id, tt.event_id, tt.tier_name, tt.price, tt.capacity, tt.quantity_sold
             FROM Ticket_Tiers tt
             JOIN Events e ON e.event_id = tt.event_id
             WHERE tt.tier_id = ? AND tt.event_id = ? AND e.approval_status = 'approved'
             LIMIT 1 FOR UPDATE`,
            [tierId, eventId]
        );
        if (!tiers.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'That ticket tier is not available for this event.' });
        }
        const tier = tiers[0];
        const unitPrice = Number(tier.price);
        const totalAmount = unitPrice * quantity;
        if (!Number.isSafeInteger(unitPrice) || unitPrice <= 0 || !Number.isSafeInteger(totalAmount) || totalAmount <= 0) {
            await connection.rollback();
            return res.status(400).json({ error: 'This ticket tier does not have a valid M-Pesa price.' });
        }

        if (tier.capacity != null) {
            const [pendingRows] = await connection.query(
                `SELECT quantity FROM Orders
                 WHERE tier_id = ? AND payment_status = 'pending'
                   AND created_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)`,
                [tierId]
            );
            const reserved = pendingRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
            const available = Number(tier.capacity) - Number(tier.quantity_sold || 0) - reserved;
            if (available < quantity) {
                await connection.rollback();
                return res.status(409).json({ error: 'There are not enough tickets left in this tier.' });
            }
        }

        const externalReference = `TWENDE-${Date.now()}-${randomUUID().toUpperCase()}`;
        const [insertResult] = await connection.query(
            `INSERT INTO Orders
                (user_id, event_id, total_amount, checkout_phone, phone_number, payment_status, external_reference,
                 tier_id, quantity, attendee_name, attendee_email, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NOW())`,
            [userId, eventId, totalAmount, phoneNumber, phoneNumber, externalReference, tierId, quantity, attendeeName, attendeeEmail]
        );
        order = { orderId: insertResult.insertId, externalReference, totalAmount, eventId, tierId, quantity, attendeeName };
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        console.error('Could not create pending M-Pesa order:', error);
        return res.status(500).json({ error: 'Could not create your payment order.' });
    } finally {
        connection.release();
    }

    try {
        const payHeroResponse = await payHeroRequest('https://backend.payhero.co.ke/api/v2/payments', {
            method: 'POST',
            body: JSON.stringify({
                amount: order.totalAmount,
                phone_number: phoneNumber,
                channel_id: channelId,
                provider: 'm-pesa',
                external_reference: order.externalReference,
                customer_name: order.attendeeName,
                callback_url: process.env.PAYHERO_CALLBACK_URL
            })
        });
        const payheroReference = payHeroResponse.reference || null;
        const checkoutRequestId = payHeroResponse.CheckoutRequestID || null;
        await pool.query(
            `UPDATE Orders SET payhero_reference = ?, payhero_checkout_request_id = ? WHERE order_id = ?`,
            [payheroReference, checkoutRequestId, order.orderId]
        );
        return res.status(200).json({
            success: true,
            orderId: order.orderId,
            externalReference: order.externalReference,
            payheroReference: payheroReference || checkoutRequestId
        });
    } catch (error) {
        console.error('PayHero STK push request failed:', error.message);
        if (error.status) {
            await pool.query(
                `UPDATE Orders SET payment_status = 'failed', payment_failure_reason = ? WHERE order_id = ? AND payment_status = 'pending'`,
                [error.message.slice(0, 1000), order.orderId]
            ).catch((updateError) => console.error('Could not mark PayHero order failed:', updateError.message));
            return res.status(502).json({ error: 'PayHero could not start the M-Pesa request. Please try again.' });
        }
        // A network timeout can happen after PayHero accepted the request. Keep the order pending
        // so its callback or the status reconciliation can still fulfill it without a duplicate charge.
        return res.status(202).json({ success: true, orderId: order.orderId, externalReference: order.externalReference, payheroReference: null });
    }
});

app.post('/api/payments/payhero-callback', async (req, res) => {
    console.log('[PayHero Callback]', JSON.stringify(req.body));
    try {
        const body = req.body || {};
        const payload = body.response || body;
        const externalReference = payload.ExternalReference || payload.external_reference || body.ExternalReference || body.external_reference;
        const payheroReference = payload.CheckoutRequestID || payload.reference || body.CheckoutRequestID || body.reference;
        const statusRaw = String(payload.Status || payload.status || body.Status || body.status || '').toUpperCase();
        const mpesaReceipt = payload.MpesaReceiptNumber || payload.mpesa_receipt_number || payload.provider_reference
            || body.MpesaReceiptNumber || body.mpesa_receipt_number || body.provider_reference || null;
        const resultCode = payload.ResultCode ?? payload.result_code ?? body.ResultCode ?? body.result_code;
        const isPaid = ['SUCCESS', 'COMPLETED'].includes(statusRaw) || Number(resultCode) === 0;
        const failedStatuses = ['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REJECTED'];
        const isFailed = failedStatuses.includes(statusRaw);

        if (!externalReference && !payheroReference) {
            console.warn('PayHero callback has no external or PayHero reference.');
        } else {
            const [orders] = await pool.query(
                `SELECT order_id, external_reference, payment_status, payhero_reference, payhero_checkout_request_id
                 FROM Orders
                 WHERE external_reference IN (?, ?) OR payhero_reference IN (?, ?)
                    OR payhero_checkout_request_id IN (?, ?)
                 LIMIT 1`,
                [externalReference || null, payheroReference || null,
                    externalReference || null, payheroReference || null,
                    externalReference || null, payheroReference || null]
            );
            if (!orders.length) {
                console.warn('[PayHero Callback] No matching Twende order:', externalReference || payheroReference);
            } else {
                const order = orders[0];
                if (payheroReference && !order.payhero_reference && !order.payhero_checkout_request_id) {
                    await pool.query(
                        `UPDATE Orders SET payhero_reference = ?, payhero_checkout_request_id = ? WHERE order_id = ?`,
                        [payheroReference, payheroReference, order.order_id]
                    );
                }
                if (isPaid) {
                    await fulfillPaidOrder(order.order_id, mpesaReceipt);
                } else if (isFailed) {
                    const reason = payload.ResultDesc || payload.result_desc || body.ResultDesc || body.result_desc
                        || `PayHero reported ${statusRaw.toLowerCase()}.`;
                    await markOrderFailed(order.order_id, reason);
                } else {
                    console.warn('[PayHero Callback] Non-terminal status received:', statusRaw || '(empty)');
                }
            }
        }
    } catch (error) {
        console.error('PayHero callback processing failed:', error);
    }
    // PayHero treats any non-2xx webhook response as retryable; the fulfillment is idempotent.
    return res.status(200).json({ received: true });
});

app.get('/api/payments/status/:externalReference', authenticateUser, async (req, res) => {
    const externalReference = String(req.params.externalReference || '');
    try {
        const [orders] = await pool.query(
            `SELECT order_id, external_reference, user_id, attendee_email, phone_number, checkout_phone,
                    payment_status, mpesa_receipt_number, payment_failure_reason,
                    payhero_reference, payhero_checkout_request_id
             FROM Orders
             WHERE external_reference = ? OR order_id = ?
             ORDER BY CASE WHEN external_reference = ? THEN 0 ELSE 1 END
             LIMIT 1`,
            [externalReference, /^\d+$/.test(externalReference) ? Number(externalReference) : null, externalReference]
        );
        if (!orders.length) return res.status(404).json({ error: 'Payment order not found.' });
        let order = orders[0];
        const [accountRows] = await pool.query(`SELECT phone_number FROM Users WHERE user_id = ? LIMIT 1`, [req.user.user_id]);
        const sameAccount = Number(order.user_id) === req.user.user_id;
        const sameEmail = String(order.attendee_email || '').toLowerCase() === req.user.email;
        const orderPhone = lastNinePhoneDigits(order.phone_number || order.checkout_phone);
        const samePhone = Boolean(orderPhone && orderPhone === lastNinePhoneDigits(accountRows[0]?.phone_number));
        if (!sameAccount && !sameEmail && !samePhone) {
            return res.status(403).json({ error: 'This payment does not belong to your account.' });
        }

        if (String(order.payment_status).toLowerCase() === 'paid') {
            const connection = await pool.getConnection();
            let tickets;
            try { tickets = await getOrderTicketCodes(connection, order.order_id); }
            finally { connection.release(); }
            return res.status(200).json({
                status: 'paid',
                payment_status: 'paid',
                mpesaReceipt: order.mpesa_receipt_number || null,
                message: 'Payment confirmed! Your tickets are ready.',
                tickets
            });
        }

        if (String(order.payment_status).toLowerCase() === 'pending') {
            const reference = order.payhero_reference || order.payhero_checkout_request_id || order.external_reference;
            try {
                const data = await fetchPayHeroTransactionStatus(reference);
                console.log('[PayHero Status Check]', JSON.stringify(data));
                const payHeroStatus = readPayHeroStatus(data);
                if (payHeroStatus.paid) {
                    const result = await fulfillPaidOrder(order.order_id, payHeroStatus.receipt);
                    const receipt = result.mpesaReceipt || payHeroStatus.receipt || order.mpesa_receipt_number || null;
                    return res.status(200).json({
                        status: 'paid',
                        payment_status: 'paid',
                        mpesaReceipt: receipt,
                        message: 'Payment confirmed! Your tickets are ready.',
                        tickets: result.tickets || []
                    });
                }
                if (payHeroStatus.failed) {
                    const failureReason = payHeroStatus.failureReason || 'M-Pesa payment failed or was cancelled.';
                    await markOrderFailed(order.order_id, failureReason);
                    return res.status(200).json({
                        status: 'failed',
                        payment_status: 'failed',
                        failureReason
                    });
                }
            } catch (statusError) {
                console.error(`[PayHero Status Check] Failed for order ${order.order_id}:`, statusError);
            }
            const [updatedOrders] = await pool.query(
                `SELECT order_id, payment_status, mpesa_receipt_number, payment_failure_reason
                 FROM Orders
                 WHERE external_reference = ? OR order_id = ?
                 ORDER BY CASE WHEN external_reference = ? THEN 0 ELSE 1 END
                 LIMIT 1`,
                [externalReference, /^\d+$/.test(externalReference) ? Number(externalReference) : null, externalReference]
            );
            order = updatedOrders[0] || order;
        }

        let tickets = [];
        if (String(order.payment_status).toLowerCase() === 'paid') {
            const connection = await pool.getConnection();
            try { tickets = await getOrderTicketCodes(connection, order.order_id); }
            finally { connection.release(); }
        }
        return res.status(200).json({
            status: String(order.payment_status || 'pending').toLowerCase(),
            payment_status: String(order.payment_status || 'pending').toLowerCase(),
            mpesaReceipt: order.mpesa_receipt_number || null,
            failureReason: order.payment_failure_reason || null,
            tickets
        });
    } catch (error) {
        console.error('Payment status lookup failed:', error);
        return res.status(500).json({ error: 'Could not check payment status right now.' });
    }
});

// Manual recovery job for pending STK orders if a PayHero webhook was delayed or missed.
app.post('/api/payments/reconcile-pending', requireAdminAccess, async (req, res) => {
    try {
        const [orders] = await pool.query(
            `SELECT order_id, external_reference, payhero_reference, payhero_checkout_request_id
             FROM Orders
             WHERE payment_status = 'pending'
               AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
             ORDER BY created_at ASC`
        );
        let reconciled = 0;
        let failed = 0;
        const errors = [];
        for (const order of orders) {
            const reference = order.payhero_reference || order.payhero_checkout_request_id || order.external_reference;
            try {
                const data = await fetchPayHeroTransactionStatus(reference);
                console.log('[PayHero Status Check]', JSON.stringify(data));
                const status = readPayHeroStatus(data);
                if (status.paid) {
                    const result = await fulfillPaidOrder(order.order_id, status.receipt);
                    if (result.status === 'paid') reconciled += 1;
                } else if (status.failed) {
                    await markOrderFailed(order.order_id, status.failureReason || 'M-Pesa payment failed or was cancelled.');
                    failed += 1;
                }
            } catch (error) {
                console.error(`[reconcile] Order ${order.order_id} status lookup failed:`, error.message);
                errors.push({ order_id: order.order_id, message: error.message });
            }
        }
        return res.status(200).json({ success: true, checked: orders.length, reconciled, failed, errors });
    } catch (error) {
        console.error('Pending payment reconciliation failed:', error);
        return res.status(500).json({ success: false, error: 'Could not reconcile pending payments.' });
    }
});

// User Login Route (Accepts Email OR Phone Number)
app.post('/api/login', async (req, res) => {
    try {
        const { identifier, password } = req.body; 

        // Check if the identifier matches either a phone number or an email
        const [users] = await pool.query(
            `SELECT user_id, full_name, email, phone_number, role 
             FROM Users 
             WHERE (phone_number = ? OR email = ?) AND password_hash = ?`,
            [identifier, identifier, password]
        );

        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = users[0];
        const adminToken = String(user.role || '').toLowerCase() === 'admin' ? createAdminToken() : undefined;
        const token = createUserToken(user);
        res.status(200).json({ message: 'Login successful', user, token, ...(adminToken ? { adminToken } : {}) });
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ error: 'Server error during login' });
    }
});

// User Registration Route
app.post('/api/register', async (req, res) => {
    try {
        const { full_name, email, phone_number, password } = req.body;

        // Prevent duplicate accounts
        const [existing] = await pool.query(
            `SELECT user_id FROM Users WHERE email = ? OR phone_number = ?`,
            [email, phone_number]
        );

        if (existing.length > 0) {
            return res.status(400).json({ error: 'User with this email or phone already exists' });
        }

        // Insert new user into the database
        await pool.query(
            `INSERT INTO Users (full_name, email, phone_number, password_hash, role) 
             VALUES (?, ?, ?, ?, 'user')`,
            [full_name, email, phone_number, password]
        );

        res.status(201).json({ message: 'Registration successful' });
    } catch (error) {
        console.error('Error during registration:', error);
        res.status(500).json({ error: 'Server error during registration' });
    }
});

// Look up ticket and event details without consuming the ticket.
app.get('/api/tickets/verify/:ticketCode', async (req, res) => {
    try {
        const ticketCode = req.params.ticketCode;
        const [tickets] = await pool.query(
            `SELECT p.ticket_code,
                    CASE WHEN LOWER(COALESCE(p.status, '')) = 'used' OR COALESCE(t.is_scanned, 0) = 1 THEN 'used' ELSE 'valid' END AS status,
                    u.full_name AS attendee_name,
                    e.title AS event_title,
                    e.venue,
                    e.start_time,
                    tt.tier_name,
                    p.purchase_date AS purchased_at
             FROM Purchased_Tickets p
             JOIN Events e ON e.event_id = p.event_id
             JOIN Users u ON u.user_id = p.user_id
             LEFT JOIN Tickets t ON t.ticket_code = p.ticket_code
             LEFT JOIN Ticket_Tiers tt ON tt.tier_id = t.tier_id
             WHERE p.ticket_code = ?
             LIMIT 1`,
            [ticketCode]
        );

        if (!tickets.length) {
            return res.status(404).json({ valid: false, status: 'invalid', error: 'Ticket not found.' });
        }

        res.status(200).json(tickets[0]);
    } catch (error) {
        console.error('Error verifying ticket:', error);
        res.status(500).json({ error: 'Failed to verify ticket' });
    }
});

// Atomically check in a ticket so simultaneous scans cannot both grant entry.
async function checkInTicket(ticketCode) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [tickets] = await connection.query(
            `SELECT p.ticket_id, p.status, t.ticket_id AS linked_ticket_id, t.is_scanned, e.title AS event_title
             FROM Purchased_Tickets p
             JOIN Events e ON e.event_id = p.event_id
             LEFT JOIN Tickets t ON t.ticket_code = p.ticket_code
             WHERE p.ticket_code = ?
             LIMIT 1
             FOR UPDATE`,
            [ticketCode]
        );

        if (!tickets.length) {
            await connection.rollback();
            return { httpStatus: 404, body: { valid: false, status: 'invalid', error: 'Ticket not found.' } };
        }

        const ticket = tickets[0];
        if (String(ticket.status || '').toLowerCase() === 'used' || Number(ticket.is_scanned) === 1) {
            await connection.rollback();
            return { httpStatus: 409, body: { valid: false, status: 'used', error: 'This ticket has already been checked in.' } };
        }

        await connection.query(`UPDATE Purchased_Tickets SET status = 'used' WHERE ticket_id = ?`, [ticket.ticket_id]);
        if (ticket.linked_ticket_id) {
            const [scanUpdate] = await connection.query(
                `UPDATE Tickets SET is_scanned = 1 WHERE ticket_id = ? AND COALESCE(is_scanned, 0) = 0`,
                [ticket.linked_ticket_id]
            );
            if (scanUpdate.affectedRows === 0) {
                await connection.rollback();
                return { httpStatus: 409, body: { valid: false, status: 'used', error: 'This ticket has already been checked in.' } };
            }
        }

        await connection.commit();
        return { httpStatus: 200, body: { valid: true, status: 'used', message: 'Ticket checked in successfully.', event_title: ticket.event_title } };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

app.post('/api/tickets/check-in/:ticketCode', async (req, res) => {
    try {
        const result = await checkInTicket(req.params.ticketCode);
        res.status(result.httpStatus).json(result.body);
    } catch (error) {
        console.error('Error checking in ticket:', error);
        res.status(500).json({ error: 'Failed to check in ticket' });
    }
});

// Scan and validate a ticket at the gate (legacy scanner endpoint)
app.post('/api/tickets/scan', async (req, res) => {
    try {
        const { ticket_code } = req.body;
        const result = await checkInTicket(ticket_code);
        if (result.httpStatus !== 200) {
            return res.status(result.httpStatus).json({ ...result.body, message: result.body.error });
        }
        res.status(200).json({ ...result.body, message: `Access Granted for ${result.body.event_title}!` });
    } catch (error) {
        console.error('Error scanning ticket:', error);
        res.status(500).json({ error: 'Server error during scan' });
    }
});

// Test the Database Connection
pool.getConnection()
    .then(connection => {
        console.log('✅ Successfully connected to the Twende Events MySQL database!');
        connection.release();
    })
    .catch(err => {
        console.error('❌ Database connection failed:', err.message);
    });

// Get a single approved event by ID AND its ticket tiers.
// Keep unapproved submissions off the public storefront, even when their ID is known.
app.get('/api/events/:id', async (req, res) => {
    try {
        const eventId = req.params.id;
        
        // 1. Fetch the main event details
        const [events] = await pool.query(
            `SELECT * FROM Events WHERE event_id = ? AND approval_status = 'approved'`,
            [eventId]
        );

        if (events.length === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }
        
        const event = events[0];

        // 2. Fetch the ticket tiers matching this event ID
        const [tickets] = await pool.query(
            `SELECT * FROM Ticket_Tiers WHERE event_id = ?`,
            [eventId]
        );

        // 3. Attach the tickets array to the event object
        event.tickets = tickets;

        // 4. Send the complete object back to the frontend
        res.status(200).json(event);
    } catch (error) {
        console.error('Error fetching event with tickets:', error);
        res.status(500).json({ error: 'Failed to fetch event details' });
    }
});

// Start the Server
const PORT = process.env.PORT || 5000;
// Create a new event WITH an image upload AND ticket tiers
app.post('/api/events', upload.single('poster'), async (req, res) => {
    try {
        const { title, category, description, venue, city, start_time, end_time } = req.body;
        const organizer_id = 1; 
        
        const poster_url = req.file ? await uploadPosterToCloudinary(req.file.buffer) : null;

        // 1. Insert the main event
        const [eventResult] = await pool.query(
            `INSERT INTO Events (organizer_id, title, category, description, venue, city, start_time, end_time, poster_url, status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`,
            [organizer_id, title, category, description, venue, city, start_time, end_time, poster_url]
        );

        const eventId = eventResult.insertId;

        // 2. Insert the ticket tiers (if any were sent)
        if (req.body.tickets) {
            // The frontend will send the tickets array as a JSON string in FormData
            const tickets = JSON.parse(req.body.tickets); 
            
            for (const ticket of tickets) {
                // Adjust column names (name, price, quantity) if your Ticket_Tiers table uses different ones
                await pool.query(
                    `INSERT INTO Ticket_Tiers (event_id, tier_name, price, capacity) 
                     VALUES (?, ?, ?, ?)`,
                    [eventId, ticket.name, ticket.price, ticket.quantity]
                );
            }
            
        }

        res.status(201).json({ message: 'Event and tickets created successfully!', eventId });
    } catch (error) {
        console.error('Error creating event:', error);
        res.status(500).json({ error: 'Failed to create event' });
    }
});

// Create a new event (defaults to 'pending' status)
app.post('/api/events/create', upload.single('poster'), async (req, res) => {
    try {
        const { title, category, venue, start_time, description, organizer_id } = req.body;
        
        // If an image was uploaded, save its Cloudinary URL, otherwise use a default placeholder.
        const poster_url = req.file
            ? await uploadPosterToCloudinary(req.file.buffer)
            : '/images/default-poster.jpg';

        await pool.query(
            `INSERT INTO Events (title, category, venue, start_time, description, poster_url, organizer_id, approval_status) 
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [title, category, venue, start_time, description, poster_url, organizer_id]
        );

        res.status(201).json({ message: 'Event submitted successfully and is pending admin approval!' });
    } catch (error) {
        console.error('Error creating event:', error);
        res.status(500).json({ error: 'Failed to submit event' });
    }
});
// Fetch all pending events WITH organizer details for the Admin Approval Queue
app.get('/api/admin/events/pending', async (req, res) => {
    try {
        const [events] = await pool.query(
            `SELECT e.event_id, e.title, e.category, e.venue, e.start_time, e.description, e.poster_url, 
                    u.full_name AS organizer_name, u.email AS organizer_email 
             FROM Events e
             JOIN Users u ON e.organizer_id = u.user_id
             WHERE e.approval_status = 'pending' 
             ORDER BY e.start_time ASC`
        );
        res.status(200).json(events);
    } catch (error) {
        console.error('Error fetching pending events:', error);
        res.status(500).json({ error: 'Failed to load pending events' });
    }
});
// Approve an event and push it live
app.put('/api/admin/events/:id/approve', async (req, res) => {
    try {
        const eventId = req.params.id;
        const [result] = await pool.query(
            `UPDATE Events SET approval_status = 'approved', status = 'published' WHERE event_id = ?`,
            [eventId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        res.status(200).json({ message: 'Event approved and is now live!' });
    } catch (error) {
        console.error('Error approving event:', error);
        res.status(500).json({ error: 'Failed to approve event' });

    }
});
// List all approved events across organizers for the admin dashboard.
app.get('/api/admin/events', async (req, res) => {
    try {
        const [events] = await pool.query(
            `SELECT * FROM Events
             WHERE approval_status = 'approved'
             ORDER BY start_time DESC`
        );
        res.status(200).json(events);
    } catch (error) {
        console.error('Error fetching admin events:', error);
        res.status(500).json({ error: 'Failed to load admin events' });
    }
});
// Update an event's details before approval
app.put('/api/admin/events/:id', async (req, res) => {
    try {
        const eventId = req.params.id;
        const { title, category, venue, start_time, description } = req.body;

        await pool.query(
            `UPDATE Events 
             SET title = ?, category = ?, venue = ?, start_time = ?, description = ? 
             WHERE event_id = ?`,
            [title, category, venue, start_time, description, eventId]
        );

        res.status(200).json({ message: 'Event updated successfully!' });
    } catch (error) {
        console.error('Error updating event:', error);
        res.status(500).json({ error: 'Failed to update event' });
    }
});
// Delete an event by ID
app.delete('/api/events/:id', requireAdminAccess, async (req, res) => {
    try {
        const eventId = req.params.id;
        
        const [result] = await pool.query(
            `DELETE FROM Events WHERE event_id = ?`,
            [eventId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        res.status(200).json({ message: 'Event deleted successfully' });
    } catch (error) {
        console.error('Error deleting event:', error);
        res.status(500).json({ error: 'Failed to delete event' });
    }
});

// Get organizer dashboard data (Events and basic stats)
app.get('/api/dashboard/:organizerId', requireAdminAccess, async (req, res) => {
    try {
        const orgId = req.params.organizerId;
        
        // Fetch all events for this specific organizer
        const [events] = await pool.query(
            `SELECT event_id, title, start_time, status, approval_status, venue
             FROM Events 
             WHERE organizer_id = ?
               AND approval_status = 'approved'
             ORDER BY start_time DESC`,
            [orgId]
        );

        // We can expand this later to include revenue and tickets sold,
        // but for now, we will send back the event count and the event list.
        res.status(200).json({
            totalEvents: events.length,
            events: events
        });
    } catch (error) {
        console.error('Error fetching dashboard data:', error);
        res.status(500).json({ error: 'Failed to load dashboard' });
    }
});

// Fetch all LIVE (approved) events for the homepage and discover pages
app.get('/api/events', async (req, res) => {
    try {
        const [events] = await pool.query(
            `SELECT * FROM Events
             WHERE approval_status = 'approved'
             ORDER BY start_time ASC`
        );
        console.log('[GET /api/events] returning:', events.map(({ event_id, title }) => ({ event_id, title })));
        res.status(200).json(events);
    } catch (error) {
        console.error('Error fetching live events:', error);
        res.status(500).json({ error: 'Failed to load events' });
    }
});
// Get all registered users for the Admin Dashboard
app.get('/api/admin/users', async (req, res) => {
    try {
        // Fetch users, explicitly excluding the password_hash for security
        const [users] = await pool.query(
            `SELECT user_id, full_name, email, phone_number, role 
             FROM Users 
             ORDER BY user_id DESC`
        );
        
        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to load users' });
    }
});
// Delete a user by ID
app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        const userId = req.params.id;
        
        const [result] = await pool.query(
            `DELETE FROM Users WHERE user_id = ?`,
            [userId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.status(200).json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Mock ticket issuance is disabled so unpaid orders cannot generate gate-valid tickets.
app.post('/api/tickets/mock-purchase', (req, res) => {
    res.status(410).json({ error: 'Mock ticket purchases are disabled. Use the M-Pesa checkout.' });
});

// 2. Fetch a user's purchased tickets
app.get('/api/user/tickets/:userId', authenticateUser, async (req, res) => {
    try {
        const userId = req.authUser.user_id;
        if (Number(req.params.userId) !== userId) {
            return res.status(403).json({ error: 'You can only view tickets for your signed-in account.' });
        }
        await reconcilePendingOrdersForUser(req.user);
        const [accountRows] = await pool.query(`SELECT phone_number FROM Users WHERE user_id = ? LIMIT 1`, [userId]);
        const email = req.authUser.email;
        const phoneDigits = lastNinePhoneDigits(accountRows[0]?.phone_number);
        const [tickets] = await pool.query(
            `SELECT pt.ticket_code,
                    CASE WHEN LOWER(COALESCE(pt.status, '')) = 'used' OR COALESCE(t.is_scanned, 0) = 1 THEN 'used' ELSE 'valid' END AS status,
                    COALESCE(pt.purchase_date, o.created_at) AS purchased_at,
                    COALESCE(NULLIF(pt.attendee_name, ''), NULLIF(o.attendee_name, ''), u.full_name) AS attendee_name,
                    e.title,
                    e.start_time,
                    e.venue,
                    e.poster_url,
                    tt.tier_name
             FROM Purchased_Tickets pt
             LEFT JOIN Events e ON pt.event_id = e.event_id
             LEFT JOIN Tickets t ON t.ticket_code = pt.ticket_code
             LEFT JOIN Orders o ON o.order_id = COALESCE(t.order_id, pt.order_id)
             LEFT JOIN Users u ON u.user_id = COALESCE(pt.user_id, o.user_id)
             LEFT JOIN Ticket_Tiers tt ON tt.tier_id = COALESCE(t.tier_id, pt.tier_id)
             WHERE pt.user_id = ?
                OR o.user_id = ?
                OR LOWER(o.attendee_email) = LOWER(?)
                OR (o.user_id IS NULL AND RIGHT(REPLACE(COALESCE(NULLIF(o.phone_number, ''), o.checkout_phone), '+', ''), 9) = ?)
             ORDER BY pt.purchase_date DESC, pt.ticket_id DESC`,
            [userId, userId, email, phoneDigits || '__NO_PHONE_MATCH__']
        );
        res.status(200).json(tickets);
    } catch (error) {
        console.error('Error fetching tickets:', error);
        res.status(500).json({ error: 'Failed to load tickets' });
    }
});
async function startServer() {
    try {
        await ensurePaymentSchema();
        app.listen(PORT, () => {
            console.log(`🚀 Server running on http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('Payment schema migration failed; server was not started:', error);
        process.exitCode = 1;
        await pool.end().catch(() => {});
    }
}

startServer();
