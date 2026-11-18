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
    database: process.env.DB_NAME,
    ssl: {
        rejectUnauthorized: false
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

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
    if (!username || !password) throw new Error('PayHero API credentials are not configured');
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
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

function normalizeKenyanPhone(phone) {
    const input = String(phone || '').trim();
    const digits = input.replace(/\D/g, '');
    if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
    if (/^254[17]\d{8}$/.test(digits)) return digits;
    throw new Error('Enter a valid Kenyan mobile number, such as 0712345678 or +254712345678.');
}

async function getOrderTicketCodes(connection, orderId) {
    const [tickets] = await connection.query(
        `SELECT p.ticket_code
         FROM Tickets t
         JOIN Purchased_Tickets p ON p.ticket_code = t.ticket_code
         WHERE t.order_id = ?
         ORDER BY t.ticket_id ASC`,
        [orderId]
    );
    return tickets.map((ticket) => ticket.ticket_code);
}

// The callback and status-poll fallback both use this transaction-safe fulfillment path.
async function applyPayHeroOutcome(externalReference, outcome) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [orders] = await connection.query(
            `SELECT order_id, user_id, event_id, total_amount, tier_id, quantity, payment_status
             FROM Orders WHERE external_reference = ? LIMIT 1 FOR UPDATE`,
            [externalReference]
        );
        if (!orders.length) {
            await connection.rollback();
            return { found: false, status: 'not_found', tickets: [] };
        }

        const order = orders[0];
        if (String(order.payment_status).toLowerCase() === 'paid') {
            const tickets = await getOrderTicketCodes(connection, order.order_id);
            await connection.commit();
            return { found: true, status: 'paid', tickets };
        }
        if (String(order.payment_status).toLowerCase() === 'failed') {
            await connection.commit();
            return { found: true, status: 'failed', tickets: [] };
        }

        if (outcome.status === 'paid') {
            if (outcome.amount != null && Number(outcome.amount) !== Number(order.total_amount)) {
                const reason = `PayHero amount mismatch: expected KES ${order.total_amount}, received KES ${outcome.amount}`;
                await connection.query(
                    `UPDATE Orders SET payment_status = 'failed', payment_failure_reason = ? WHERE order_id = ?`,
                    [reason, order.order_id]
                );
                await connection.commit();
                return { found: true, status: 'failed', tickets: [], failureReason: reason };
            }

            const [tierRows] = await connection.query(
                `SELECT tier_id FROM Ticket_Tiers WHERE tier_id = ? AND event_id = ? LIMIT 1 FOR UPDATE`,
                [order.tier_id, order.event_id]
            );
            if (!tierRows.length) throw new Error('The ticket tier for this paid order no longer exists');

            await connection.query(
                `UPDATE Ticket_Tiers SET quantity_sold = COALESCE(quantity_sold, 0) + ? WHERE tier_id = ?`,
                [order.quantity, order.tier_id]
            );
            await connection.query(
                `UPDATE Orders
                 SET payment_status = 'paid', mpesa_receipt_number = ?, payment_failure_reason = NULL
                 WHERE order_id = ?`,
                [outcome.receipt || null, order.order_id]
            );

            const ticketCodes = [];
            for (let index = 0; index < Number(order.quantity); index += 1) {
                const ticketCode = randomUUID();
                ticketCodes.push(ticketCode);
                await connection.query(
                    `INSERT INTO Purchased_Tickets (user_id, event_id, ticket_code) VALUES (?, ?, ?)`,
                    [order.user_id, order.event_id, ticketCode]
                );
                await connection.query(
                    `INSERT INTO Tickets (order_id, tier_id, user_id, ticket_code, is_scanned, created_at) VALUES (?, ?, ?, ?, 0, NOW())`,
                    [order.order_id, order.tier_id, order.user_id, ticketCode]
                );
            }
            await connection.commit();
            return { found: true, status: 'paid', tickets: ticketCodes };
        }

        const reason = outcome.failureReason || 'M-Pesa payment was not completed.';
        await connection.query(
            `UPDATE Orders SET payment_status = 'failed', payment_failure_reason = ? WHERE order_id = ?`,
            [reason, order.order_id]
        );
        await connection.commit();
        return { found: true, status: 'failed', tickets: [], failureReason: reason };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

app.post('/api/payments/stk-push', async (req, res) => {
    const {
        user_id: rawUserId, event_id: rawEventId, tier_id: rawTierId, quantity: rawQuantity,
        attendee_name: rawAttendeeName, attendee_email: rawAttendeeEmail, phone_number: rawPhone
    } = req.body || {};
    const userId = Number(rawUserId);
    const eventId = Number(rawEventId);
    const tierId = Number(rawTierId);
    const quantity = Number(rawQuantity);
    const attendeeName = String(rawAttendeeName || '').trim();
    const attendeeEmail = String(rawAttendeeEmail || '').trim();

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
                (user_id, event_id, total_amount, checkout_phone, payment_status, external_reference,
                 tier_id, quantity, attendee_name, attendee_email, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NOW())`,
            [userId, eventId, totalAmount, phoneNumber, externalReference, tierId, quantity, attendeeName, attendeeEmail]
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
    try {
        const payload = req.body || {};
        const response = payload.response || payload;
        const externalReference = response.ExternalReference || response.external_reference || payload.external_reference;
        const status = String(response.Status || response.status || '').toLowerCase();
        const terminalFailureStatuses = ['failed', 'cancelled', 'canceled', 'expired', 'rejected'];
        if (externalReference && (status === 'success' || terminalFailureStatuses.includes(status))) {
            const [orders] = await pool.query(
                `SELECT payhero_reference, payhero_checkout_request_id, payment_status
                 FROM Orders WHERE external_reference = ? LIMIT 1`,
                [externalReference]
            );
            if (!orders.length) {
                console.warn('PayHero callback did not match a Twende order.');
            } else if (String(orders[0].payment_status).toLowerCase() !== 'pending') {
                // Repeated callbacks after settlement are safely ignored.
            } else {
                let reference = orders[0].payhero_reference || orders[0].payhero_checkout_request_id;
                if (!reference && response.CheckoutRequestID) {
                    reference = String(response.CheckoutRequestID);
                    await pool.query(
                        `UPDATE Orders SET payhero_checkout_request_id = ? WHERE external_reference = ? AND payment_status = 'pending'`,
                        [reference, externalReference]
                    );
                }
                if (!reference) {
                    console.warn('PayHero callback ignored until the payment reference is saved or the order is pending.');
                } else {
                    const verified = await fetchPayHeroTransactionStatus(reference);
                    const verifiedStatus = String(verified.status || verified.Status || '').toLowerCase();
                    if (status === 'success' && verifiedStatus === 'success') {
                        await applyPayHeroOutcome(externalReference, {
                            status: 'paid',
                            amount: response.Amount ?? response.amount ?? verified.amount ?? verified.Amount,
                            receipt: response.MpesaReceiptNumber || response.mpesa_receipt_number || verified.MpesaReceiptNumber || verified.provider_reference || null
                        });
                    } else if (status !== 'success' && terminalFailureStatuses.includes(verifiedStatus)) {
                        await applyPayHeroOutcome(externalReference, {
                            status: 'failed',
                            failureReason: response.ResultDesc || response.result_desc || verified.ResultDesc || 'M-Pesa payment failed or was cancelled.'
                        });
                    } else {
                        console.warn('PayHero callback received, but the transaction is not terminal in PayHero yet.');
                    }
                }
            }
        } else {
            console.warn('PayHero callback had no usable external reference/status.');
        }
    } catch (error) {
        console.error('PayHero callback processing failed:', error);
    }
    // PayHero treats any non-2xx webhook response as retryable; the fulfillment is idempotent.
    return res.status(200).json({ received: true });
});

app.get('/api/payments/status/:externalReference', async (req, res) => {
    const externalReference = String(req.params.externalReference || '');
    try {
        const [orders] = await pool.query(
            `SELECT order_id, payment_status, mpesa_receipt_number, payment_failure_reason,
                    payhero_reference, payhero_checkout_request_id
             FROM Orders WHERE external_reference = ? LIMIT 1`,
            [externalReference]
        );
        if (!orders.length) return res.status(404).json({ error: 'Payment order not found.' });
        let order = orders[0];

        if (String(order.payment_status).toLowerCase() === 'pending') {
            const reference = order.payhero_reference || order.payhero_checkout_request_id;
            if (reference) {
                try {
                    const payHeroStatus = await fetchPayHeroTransactionStatus(reference);
                    const status = String(payHeroStatus.status || payHeroStatus.Status || '').toLowerCase();
                    if (status === 'success') {
                        await applyPayHeroOutcome(externalReference, {
                            status: 'paid',
                            amount: payHeroStatus.amount ?? payHeroStatus.Amount,
                            receipt: payHeroStatus.MpesaReceiptNumber || payHeroStatus.provider_reference || null
                        });
                    } else if (['failed', 'cancelled', 'canceled', 'expired', 'rejected'].includes(status)) {
                        await applyPayHeroOutcome(externalReference, {
                            status: 'failed',
                            failureReason: payHeroStatus.ResultDesc || payHeroStatus.result_desc || 'M-Pesa payment failed or was cancelled.'
                        });
                    }
                } catch (statusError) {
                    console.warn('PayHero status fallback is not available yet:', statusError.message);
                }
            }
            const [updatedOrders] = await pool.query(
                `SELECT order_id, payment_status, mpesa_receipt_number, payment_failure_reason
                 FROM Orders WHERE external_reference = ? LIMIT 1`,
                [externalReference]
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
            mpesaReceipt: order.mpesa_receipt_number || null,
            failureReason: order.payment_failure_reason || null,
            tickets
        });
    } catch (error) {
        console.error('Payment status lookup failed:', error);
        return res.status(500).json({ error: 'Could not check payment status right now.' });
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
        res.status(200).json({ message: 'Login successful', user, ...(adminToken ? { adminToken } : {}) });
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
app.get('/api/user/tickets/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const [tickets] = await pool.query(
            `SELECT p.ticket_code,
                    CASE WHEN LOWER(COALESCE(p.status, '')) = 'used' OR COALESCE(t.is_scanned, 0) = 1 THEN 'used' ELSE 'valid' END AS status,
                    p.purchase_date AS purchased_at,
                    u.full_name AS attendee_name,
                    e.title,
                    e.start_time,
                    e.venue,
                    e.poster_url,
                    tt.tier_name
             FROM Purchased_Tickets p
             JOIN Events e ON p.event_id = e.event_id
             JOIN Users u ON u.user_id = p.user_id
             LEFT JOIN Tickets t ON t.ticket_code = p.ticket_code
             LEFT JOIN Ticket_Tiers tt ON tt.tier_id = t.tier_id
             WHERE p.user_id = ?
             ORDER BY p.purchase_date DESC`,
            [userId]
        );
        res.status(200).json(tickets);
    } catch (error) {
        console.error('Error fetching tickets:', error);
        res.status(500).json({ error: 'Failed to load tickets' });
    }
});
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
