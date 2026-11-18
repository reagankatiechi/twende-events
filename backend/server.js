const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
require('dotenv').config();

const app = express();
const multer = require('multer');
const path = require('path');
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

        res.status(200).json({ message: 'Login successful', user: users[0] });
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
app.delete('/api/events/:id', async (req, res) => {
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
app.get('/api/dashboard/:organizerId', async (req, res) => {
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

const { v4: uuidv4 } = require('uuid');

// 1. Mock Purchase Route (To test QR generation)
app.post('/api/tickets/mock-purchase', async (req, res) => {
    try {
        const { user_id, event_id } = req.body;
        const ticket_code = uuidv4(); // Generates a secure, random string like '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'

        await pool.query(
            `INSERT INTO Purchased_Tickets (user_id, event_id, ticket_code) VALUES (?, ?, ?)`,
            [user_id, event_id, ticket_code]
        );
        res.status(201).json({ message: 'Ticket generated successfully!', ticket_code });
    } catch (error) {
        console.error('Error generating ticket:', error);
        res.status(500).json({ error: 'Failed to generate ticket' });
    }
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
