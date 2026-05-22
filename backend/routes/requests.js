const express = require('express');
const router = express.Router();
const pool = require('../db');
const { getUserIdFromToken } = require('../middleware/auth');
const { generateTicketNumber } = require('../services/ticketGenerator');
const { sendEmail } = require('../services/emailService');

// Helper: get default assignee for a category
async function getDefaultAssignee(category) {
    const res = await pool.query(`SELECT fallback_user_id FROM category_assignments WHERE category = $1`, [category]);
    return res.rows[0]?.fallback_user_id || null;
}

// GET /api/requests – list tickets based on user permissions
router.get('/', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    try {
        // Get categories this user can manage
        const perms = await pool.query(
            'SELECT category FROM user_service_permissions WHERE user_id = $1',
            [userId]
        );
        const managedCategories = perms.rows.map(row => row.category);
        console.log(`User ${userId} manages categories:`, managedCategories);

        let result;
        if (managedCategories.length > 0) {
            // Manager: return tickets of managed categories
            result = await pool.query(`
                SELECT r.id, r.ticket_number, r.category, r.title, r.description, r.form_data, r.status, r.priority, r.attachments, r.created_by, r.assigned_to, r.created_at, r.updated_at, r.resolved_at,
                       u.full_name as requester_name, u.email as requester_email
                FROM service_requests r
                JOIN users u ON r.created_by = u.id
                WHERE r.category = ANY($1)
                ORDER BY r.created_at DESC
            `, [managedCategories]);
        } else {
            // Regular user: only their own tickets
            result = await pool.query(`
                SELECT r.id, r.ticket_number, r.category, r.title, r.description, r.form_data, r.status, r.priority, r.attachments, r.created_by, r.assigned_to, r.created_at, r.updated_at, r.resolved_at,
                       u.full_name as requester_name, u.email as requester_email
                FROM service_requests r
                JOIN users u ON r.created_by = u.id
                WHERE r.created_by = $1
                ORDER BY r.created_at DESC
            `, [userId]);
        }
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// POST /api/requests – create a new request
router.post('/', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { category, title, description, form_data, priority, attachments } = req.body;
    if (!category || !title) {
        return res.status(400).json({ message: 'Category and title are required' });
    }

    try {
        const ticketNumber = await generateTicketNumber(category, pool);
        const assignedTo = await getDefaultAssignee(category);
        const result = await pool.query(
            `INSERT INTO service_requests
             (ticket_number, category, title, description, form_data, priority, attachments, created_by, assigned_to, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_approval')
             RETURNING *`,
            [ticketNumber, category, title, description, form_data || {}, priority || 'normal', attachments || null, userId, assignedTo]
        );
        const newRequest = result.rows[0];

        // Notify assignee (if any)
        if (assignedTo) {
            await pool.query(
                `INSERT INTO request_notifications (user_id, request_id, message)
                 VALUES ($1, $2, $3)`,
                [assignedTo, newRequest.id, `New ${category} request #${ticketNumber} awaiting approval`]
            );
            const assignee = await pool.query('SELECT email FROM users WHERE id = $1', [assignedTo]);
            if (assignee.rows[0]?.email) {
                await sendEmail(
                    assignee.rows[0].email,
                    `New ${category} Request: ${ticketNumber}`,
                    `<h3>New request</h3><p>Title: ${title}</p><a href="http://localhost:3000/request-detail.html?id=${newRequest.id}">View</a>`
                );
            }
        }

        // Notify requester
        const requester = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
        if (requester.rows[0]?.email) {
            await sendEmail(
                requester.rows[0].email,
                `Request Submitted: ${ticketNumber}`,
                `<p>Your ${category} request has been submitted.</p><a href="http://localhost:3000/request-detail.html?id=${newRequest.id}">Track</a>`
            );
        }

        res.status(201).json(newRequest);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// GET /api/requests/:id – single request with comments
router.get('/:id', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    if (isNaN(requestId)) return res.status(400).json({ message: 'Invalid ID' });

    try {
        const ticketResult = await pool.query(`
            SELECT r.id, r.ticket_number, r.category, r.title, r.description, r.form_data, r.status, r.priority, r.attachments, r.created_by, r.assigned_to, r.created_at, r.updated_at, r.resolved_at,
                   u.full_name as requester_name, u.email as requester_email
            FROM service_requests r
            JOIN users u ON r.created_by = u.id
            WHERE r.id = $1
        `, [requestId]);
        if (ticketResult.rows.length === 0) return res.status(404).json({ message: 'Not found' });
        const ticket = ticketResult.rows[0];

        // Check permissions: owner or manager of that category
        const perms = await pool.query(
            'SELECT category FROM user_service_permissions WHERE user_id = $1 AND category = $2',
            [userId, ticket.category]
        );
        const isManager = perms.rows.length > 0;
        if (ticket.created_by !== userId && !isManager) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const comments = await pool.query(`
            SELECT c.*, u.full_name as author_name
            FROM request_comments c
            JOIN users u ON c.author_id = u.id
            WHERE c.request_id = $1
            ORDER BY c.created_at ASC
        `, [requestId]);
        res.json({ ticket, comments: comments.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// POST /api/requests/:id/comment
router.post('/:id/comment', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    const { message, is_internal } = req.body;
    if (!message) return res.status(400).json({ message: 'Message required' });

    try {
        const ticket = await pool.query('SELECT created_by, assigned_to, category FROM service_requests WHERE id = $1', [requestId]);
        if (ticket.rows.length === 0) return res.status(404).json({ message: 'Request not found' });

        // Check permissions
        const perms = await pool.query(
            'SELECT category FROM user_service_permissions WHERE user_id = $1 AND category = $2',
            [userId, ticket.rows[0].category]
        );
        const isManager = perms.rows.length > 0;
        if (ticket.rows[0].created_by !== userId && !isManager) {
            return res.status(403).json({ message: 'Access denied' });
        }

        await pool.query(
            `INSERT INTO request_comments (request_id, author_id, message, is_internal)
             VALUES ($1, $2, $3, $4)`,
            [requestId, userId, message, is_internal || false]
        );

        // Notify the other party
        const otherPartyId = (ticket.rows[0].created_by === userId) ? ticket.rows[0].assigned_to : ticket.rows[0].created_by;
        if (otherPartyId) {
            await pool.query(
                `INSERT INTO request_notifications (user_id, request_id, message)
                 VALUES ($1, $2, $3)`,
                [otherPartyId, requestId, `New comment on request #${requestId}`]
            );
            const other = await pool.query('SELECT email FROM users WHERE id = $1', [otherPartyId]);
            if (other.rows[0]?.email) {
                await sendEmail(
                    other.rows[0].email,
                    `New comment on request #${requestId}`,
                    `<p>${message}</p><a href="http://localhost:3000/request-detail.html?id=${requestId}">View</a>`
                );
            }
        }

        res.status(201).json({ message: 'Comment added' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// PUT /api/requests/:id/status – manager only
router.put('/:id/status', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: 'Status required' });

    try {
        const ticket = await pool.query('SELECT created_by, category FROM service_requests WHERE id = $1', [requestId]);
        if (ticket.rows.length === 0) return res.status(404).json({ message: 'Not found' });

        // Check if user is manager for this category
        const perms = await pool.query(
            'SELECT category FROM user_service_permissions WHERE user_id = $1 AND category = $2',
            [userId, ticket.rows[0].category]
        );
        if (perms.rows.length === 0) {
            return res.status(403).json({ message: 'Manager access required' });
        }

        let resolvedAt = null;
        if (status === 'resolved') resolvedAt = new Date();
        const result = await pool.query(
            `UPDATE service_requests SET status = $1, resolved_at = COALESCE($2, resolved_at), updated_at = NOW()
             WHERE id = $3 RETURNING *`,
            [status, resolvedAt, requestId]
        );
        const updated = result.rows[0];
        // Notify requester
        await pool.query(
            `INSERT INTO request_notifications (user_id, request_id, message)
             VALUES ($1, $2, $3)`,
            [updated.created_by, requestId, `Status updated to "${status}"`]
        );
        const requester = await pool.query('SELECT email FROM users WHERE id = $1', [updated.created_by]);
        if (requester.rows[0]?.email) {
            await sendEmail(
                requester.rows[0].email,
                `Request #${updated.ticket_number} status: ${status}`,
                `<p>Your request has been updated to <strong>${status}</strong>.</p><a href="http://localhost:3000/request-detail.html?id=${requestId}">View</a>`
            );
        }
        res.json(updated);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// PUT /api/requests/:id/approve – manager only
router.put('/:id/approve', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    try {
        const ticket = await pool.query('SELECT created_by, category, ticket_number FROM service_requests WHERE id = $1', [requestId]);
        if (ticket.rows.length === 0) return res.status(404).json({ message: 'Not found' });

        const perms = await pool.query(
            'SELECT category FROM user_service_permissions WHERE user_id = $1 AND category = $2',
            [userId, ticket.rows[0].category]
        );
        if (perms.rows.length === 0) {
            return res.status(403).json({ message: 'Manager access required' });
        }

        const result = await pool.query(
            `UPDATE service_requests SET status = 'approved', updated_at = NOW()
             WHERE id = $1 AND status = 'pending_approval' RETURNING *`,
            [requestId]
        );
        if (result.rows.length === 0) return res.status(404).json({ message: 'Already processed or not found' });
        const updated = result.rows[0];

        await pool.query(
            `INSERT INTO request_notifications (user_id, request_id, message)
             VALUES ($1, $2, $3)`,
            [updated.created_by, requestId, `Your request #${updated.ticket_number} has been approved.`]
        );
        const requester = await pool.query('SELECT email FROM users WHERE id = $1', [updated.created_by]);
        if (requester.rows[0]?.email) {
            await sendEmail(
                requester.rows[0].email,
                `Request Approved: ${updated.ticket_number}`,
                `<p>Your request has been approved.</p><a href="http://localhost:3000/request-detail.html?id=${requestId}">View</a>`
            );
        }
        res.json({ message: 'Approved' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;