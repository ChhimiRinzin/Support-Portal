const express = require('express');
const router = express.Router();
const pool = require('../db');
const { getUserIdFromToken } = require('../middleware/auth');
const { generateTicketNumber } = require('../services/ticketGenerator');
const { sendEmail } = require('../services/emailService');

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

// Default assignee for a category (fallback when no division head found)
async function getDefaultAssignee(category) {
    const res = await pool.query(
        'SELECT fallback_user_id FROM category_assignments WHERE category = $1',
        [category]
    );
    return res.rows[0]?.fallback_user_id || null;
}

// Division head for a given division
async function getDivisionHead(division) {
    if (!division) return null;
    const res = await pool.query(
        'SELECT id FROM users WHERE division = $1 AND is_division_head = true LIMIT 1',
        [division]
    );
    return res.rows[0]?.id || null;
}

// Vehicle allocator — identified by is_vehicle_allocator = true on the users table
async function getVehicleAdmin() {
    const res = await pool.query(
        'SELECT id FROM users WHERE is_vehicle_allocator = true LIMIT 1'
    );
    return res.rows[0]?.id || null;
}

// Check whether a user can manage a ticket:
//   - is currently assigned_to the ticket (covers division heads AND vehicle allocator), OR
//   - has service_permissions for the category, OR
//   - is the vehicle allocator (is_vehicle_allocator = true) and ticket is a vehicle ticket
async function canManage(userId, ticket) {
    if (ticket.assigned_to === userId) return true;
    const permRes = await pool.query(
        'SELECT 1 FROM user_service_permissions WHERE user_id = $1 AND category = $2',
        [userId, ticket.category]
    );
    if (permRes.rows.length > 0) return true;
    // Vehicle allocator can manage any vehicle ticket
    if (ticket.category === 'vehicle') {
        const allocRes = await pool.query(
            'SELECT 1 FROM users WHERE id = $1 AND is_vehicle_allocator = true',
            [userId]
        );
        if (allocRes.rows.length > 0) return true;
    }
    return false;
}

// ─────────────────────────────────────────────────────────────
// GET /api/requests
// Returns:
//   - tickets the user created
//   - tickets assigned to the user  (covers division heads)
//   - tickets in categories the user manages (service_permissions)
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    try {
        const perms = await pool.query(
            'SELECT category FROM user_service_permissions WHERE user_id = $1',
            [userId]
        );
        const managedCategories = perms.rows.map(r => r.category);

        // Base query fragment reused across all three sets.
        // LEFT JOIN on the assignee so we can return their name instead of
        // a raw user id — assigned_to can be NULL, so this must be a LEFT JOIN.
        const selectCols = `
            r.id, r.ticket_number, r.category, r.title, r.description,
            r.form_data, r.status, r.priority, r.attachments,
            r.created_by, r.assigned_to, r.created_at, r.updated_at, r.resolved_at,
            u.full_name AS requester_name, u.email AS requester_email,
            a.full_name AS assigned_to_name
        `;
        const fromJoins = `
            FROM service_requests r
            JOIN users u ON r.created_by = u.id
            LEFT JOIN users a ON r.assigned_to = a.id
        `;

        // 1. Tickets the user created
        const ownResult = await pool.query(
            `SELECT ${selectCols} ${fromJoins}
             WHERE r.created_by = $1`,
            [userId]
        );

        // 2. Tickets assigned to the user but NOT created by them
        //    (division head approval queue, vehicle admin allocation queue)
        const assignedResult = await pool.query(
            `SELECT ${selectCols} ${fromJoins}
             WHERE r.assigned_to = $1 AND r.created_by != $1`,
            [userId]
        );

        // 3. Tickets in managed categories (not created by this user)
        let managedResult = { rows: [] };
        if (managedCategories.length > 0) {
            managedResult = await pool.query(
                `SELECT ${selectCols} ${fromJoins}
                 WHERE r.category = ANY($1) AND r.created_by != $2`,
                [managedCategories, userId]
            );
        }

        // 4. Vehicle allocator: see ALL vehicle tickets not created by themselves
        //    (so they have full visibility even before a ticket is assigned to them)
        let vehicleAllocResult = { rows: [] };
        const allocCheck = await pool.query(
            'SELECT 1 FROM users WHERE id = $1 AND is_vehicle_allocator = true',
            [userId]
        );
        if (allocCheck.rows.length > 0) {
            vehicleAllocResult = await pool.query(
                `SELECT ${selectCols} ${fromJoins}
                 WHERE r.category = 'vehicle' AND r.created_by != $1`,
                [userId]
            );
        }

        // Merge and deduplicate by id, sort newest first
        const seen = new Set();
        const combined = [];
        for (const row of [...ownResult.rows, ...assignedResult.rows, ...managedResult.rows, ...vehicleAllocResult.rows]) {
            if (!seen.has(row.id)) {
                seen.add(row.id);
                combined.push(row);
            }
        }
        combined.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json(combined);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /api/requests  — create a new request
// ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { category, title, description, form_data, priority, attachments } = req.body;
    if (!category || !title) {
        return res.status(400).json({ message: 'Category and title are required' });
    }

    try {
        const ticketNumber = await generateTicketNumber(category, pool);
        let assignedTo = null;

        // Vehicle requests go to the division head first
        if (category === 'vehicle') {
            const userRes = await pool.query(
                'SELECT division FROM users WHERE id = $1', [userId]
            );
            const division = userRes.rows[0]?.division;
            if (division) {
                assignedTo = await getDivisionHead(division);
            }
        }

        // Fallback: default assignee from category_assignments
        if (!assignedTo) {
            assignedTo = await getDefaultAssignee(category);
        }

        const result = await pool.query(
            `INSERT INTO service_requests
             (ticket_number, category, title, description, form_data, priority,
              attachments, created_by, assigned_to, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_approval')
             RETURNING *`,
            [
                ticketNumber, category, title, description,
                form_data || {}, priority || 'normal',
                attachments || null, userId, assignedTo
            ]
        );
        const newRequest = result.rows[0];

        // Notify assignee
        if (assignedTo) {
            await pool.query(
                `INSERT INTO request_notifications (user_id, request_id, message)
                 VALUES ($1, $2, $3)`,
                [assignedTo, newRequest.id,
                 `New ${category} request #${ticketNumber} awaiting your approval`]
            );
            const assignee = await pool.query(
                'SELECT email FROM users WHERE id = $1', [assignedTo]
            );
            if (assignee.rows[0]?.email) {
                await sendEmail(
                    assignee.rows[0].email,
                    `New ${category} Request: ${ticketNumber}`,
                    `<h3>New request pending approval</h3>
                     <p><strong>Title:</strong> ${title}</p>
                     <a href="http://localhost:3000/manager-dashboard.html">View on dashboard</a>`
                );
            }
        }

        // Notify requester
        const requester = await pool.query(
            'SELECT email FROM users WHERE id = $1', [userId]
        );
        if (requester.rows[0]?.email) {
            await sendEmail(
                requester.rows[0].email,
                `Request Submitted: ${ticketNumber}`,
                `<p>Your ${category} request has been submitted and is pending approval.</p>
                 <a href="http://localhost:3000/dashboard.html">Track your request</a>`
            );
        }

        res.status(201).json(newRequest);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/requests/:id  — fetch single ticket + comments
// Accessible by: creator, assigned user, category manager
// ─────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    if (isNaN(requestId)) return res.status(400).json({ message: 'Invalid ID' });

    try {
        const ticketResult = await pool.query(
            `SELECT r.id, r.ticket_number, r.category, r.title, r.description,
                    r.form_data, r.status, r.priority, r.attachments,
                    r.created_by, r.assigned_to, r.created_at, r.updated_at, r.resolved_at,
                    u.full_name AS requester_name, u.email AS requester_email,
                    a.full_name AS assigned_to_name
             FROM service_requests r
             JOIN users u ON r.created_by = u.id
             LEFT JOIN users a ON r.assigned_to = a.id
             WHERE r.id = $1`,
            [requestId]
        );
        if (ticketResult.rows.length === 0) {
            return res.status(404).json({ message: 'Not found' });
        }
        const ticket = ticketResult.rows[0];

        // Access check: creator, assigned user, or category manager
        const isCreator = ticket.created_by === userId;
        const managing = await canManage(userId, ticket);
        if (!isCreator && !managing) {
            return res.status(403).json({ message: 'Access denied' });
        }

        const comments = await pool.query(
            `SELECT c.*, u.full_name AS author_name
             FROM request_comments c
             JOIN users u ON c.author_id = u.id
             WHERE c.request_id = $1
             ORDER BY c.created_at ASC`,
            [requestId]
        );

        res.json({ ticket, comments: comments.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /api/requests/:id/comment
// Accessible by: creator, assigned user, category manager
// ─────────────────────────────────────────────────────────────
router.post('/:id/comment', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    const { message, is_internal } = req.body;
    if (!message) return res.status(400).json({ message: 'Message required' });

    try {
        const ticketRes = await pool.query(
            'SELECT created_by, assigned_to, category FROM service_requests WHERE id = $1',
            [requestId]
        );
        if (ticketRes.rows.length === 0) {
            return res.status(404).json({ message: 'Request not found' });
        }
        const ticket = ticketRes.rows[0];

        const isCreator = ticket.created_by === userId;
        const managing = await canManage(userId, ticket);
        if (!isCreator && !managing) {
            return res.status(403).json({ message: 'Access denied' });
        }

        await pool.query(
            `INSERT INTO request_comments (request_id, author_id, message, is_internal)
             VALUES ($1, $2, $3, $4)`,
            [requestId, userId, message, is_internal || false]
        );

        // Notify the other party
        const otherPartyId = (ticket.created_by === userId)
            ? ticket.assigned_to
            : ticket.created_by;

        if (otherPartyId) {
            await pool.query(
                `INSERT INTO request_notifications (user_id, request_id, message)
                 VALUES ($1, $2, $3)`,
                [otherPartyId, requestId, `New comment on request #${requestId}`]
            );
            const other = await pool.query(
                'SELECT email FROM users WHERE id = $1', [otherPartyId]
            );
            if (other.rows[0]?.email) {
                await sendEmail(
                    other.rows[0].email,
                    `New comment on request #${requestId}`,
                    `<p>${message}</p>
                     <a href="http://localhost:3000/dashboard.html">View request</a>`
                );
            }
        }

        res.status(201).json({ message: 'Comment added' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/requests/:id/status
// Accessible by: category manager OR assigned user
// ─────────────────────────────────────────────────────────────
router.put('/:id/status', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: 'Status required' });

    try {
        const ticketRes = await pool.query(
            'SELECT created_by, assigned_to, category, ticket_number FROM service_requests WHERE id = $1',
            [requestId]
        );
        if (ticketRes.rows.length === 0) {
            return res.status(404).json({ message: 'Not found' });
        }
        const ticket = ticketRes.rows[0];

        const managing = await canManage(userId, ticket);
        if (!managing) {
            return res.status(403).json({ message: 'Manager or assignee access required' });
        }

        // Guard: vehicle tickets that are still pending_approval must go
        // through PUT /:id/approve or PUT /:id/reject, NOT this generic
        // endpoint. Approving directly here would skip re-assigning the
        // ticket to the vehicle allocator, leaving it stuck.
        if (ticket.category === 'vehicle' && ticket.status === 'pending_approval' &&
            (status === 'approved' || status === 'rejected')) {
            return res.status(400).json({
                message: `Vehicle requests must be ${status === 'approved' ? 'approved' : 'rejected'} using the dedicated /${status === 'approved' ? 'approve' : 'reject'} action, not a direct status change.`
            });
        }

        const resolvedAt = status === 'resolved' ? new Date() : null;
        const result = await pool.query(
            `UPDATE service_requests
             SET status = $1, resolved_at = COALESCE($2, resolved_at), updated_at = NOW()
             WHERE id = $3 RETURNING *`,
            [status, resolvedAt, requestId]
        );
        const updated = result.rows[0];

        await pool.query(
            `INSERT INTO request_notifications (user_id, request_id, message)
             VALUES ($1, $2, $3)`,
            [updated.created_by, requestId, `Your request #${updated.ticket_number} status updated to "${status}"`]
        );

        const requester = await pool.query(
            'SELECT email FROM users WHERE id = $1', [updated.created_by]
        );
        if (requester.rows[0]?.email) {
            await sendEmail(
                requester.rows[0].email,
                `Request #${updated.ticket_number} status: ${status}`,
                `<p>Your request has been updated to <strong>${status}</strong>.</p>
                 <a href="http://localhost:3000/dashboard.html">View request</a>`
            );
        }

        res.json(updated);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/requests/:id/approve
// Only the currently assigned user (division head) can approve.
// On approval: status → 'approved', re-assign to vehicle admin.
// ─────────────────────────────────────────────────────────────
router.put('/:id/approve', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    try {
        const ticketRes = await pool.query(
            `SELECT created_by, category, assigned_to, status, ticket_number
             FROM service_requests WHERE id = $1`,
            [requestId]
        );
        if (ticketRes.rows.length === 0) {
            return res.status(404).json({ message: 'Not found' });
        }
        const t = ticketRes.rows[0];

        if (t.assigned_to !== userId) {
            return res.status(403).json({ message: 'Only the assigned approver can approve this request' });
        }
        if (t.status !== 'pending_approval') {
            return res.status(400).json({ message: 'Request is not pending approval' });
        }

        // Find vehicle admin to forward to
        const adminId = await getVehicleAdmin();
        if (!adminId) {
            return res.status(500).json({ message: 'No vehicle admin found — cannot forward request' });
        }

        const result = await pool.query(
            `UPDATE service_requests
             SET status = 'approved', assigned_to = $1, updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [adminId, requestId]
        );
        const updated = result.rows[0];

        // Notify requester
        await pool.query(
            `INSERT INTO request_notifications (user_id, request_id, message)
             VALUES ($1, $2, $3)`,
            [updated.created_by, requestId,
             `Your request #${updated.ticket_number} has been approved and forwarded for vehicle allocation.`]
        );

        // Notify vehicle admin
        await pool.query(
            `INSERT INTO request_notifications (user_id, request_id, message)
             VALUES ($1, $2, $3)`,
            [adminId, requestId,
             `Request #${updated.ticket_number} approved — please allocate a vehicle.`]
        );

        // Email requester
        const requester = await pool.query(
            'SELECT email FROM users WHERE id = $1', [updated.created_by]
        );
        if (requester.rows[0]?.email) {
            await sendEmail(
                requester.rows[0].email,
                `Request Approved: ${updated.ticket_number}`,
                `<p>Your vehicle request has been approved and forwarded for allocation.</p>
                 <a href="http://localhost:3000/dashboard.html">Track your request</a>`
            );
        }

        // Email vehicle admin
        const adminUser = await pool.query(
            'SELECT email FROM users WHERE id = $1', [adminId]
        );
        if (adminUser.rows[0]?.email) {
            await sendEmail(
                adminUser.rows[0].email,
                `Vehicle Request Ready for Allocation: ${updated.ticket_number}`,
                `<p>A vehicle request has been approved and needs allocation.</p>
                 <a href="http://localhost:3000/manager-dashboard.html">Open dashboard</a>`
            );
        }

        res.json({ message: 'Approved and forwarded to vehicle admin', ticket: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/requests/:id/reject
// Only the currently assigned user (division head) can reject.
// On rejection: status → 'rejected', optional reason stored as comment.
// ─────────────────────────────────────────────────────────────
router.put('/:id/reject', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    const { reason } = req.body; // optional rejection reason

    try {
        const ticketRes = await pool.query(
            `SELECT created_by, category, assigned_to, status, ticket_number
             FROM service_requests WHERE id = $1`,
            [requestId]
        );
        if (ticketRes.rows.length === 0) {
            return res.status(404).json({ message: 'Not found' });
        }
        const t = ticketRes.rows[0];

        if (t.assigned_to !== userId) {
            return res.status(403).json({ message: 'Only the assigned approver can reject this request' });
        }
        if (t.status !== 'pending_approval') {
            return res.status(400).json({ message: 'Request is not pending approval' });
        }

        // Update status to rejected
        const result = await pool.query(
            `UPDATE service_requests
             SET status = 'rejected', updated_at = NOW()
             WHERE id = $1 RETURNING *`,
            [requestId]
        );
        const updated = result.rows[0];

        // Store rejection reason as an internal comment (visible to managers)
        if (reason && reason.trim()) {
            await pool.query(
                `INSERT INTO request_comments (request_id, author_id, message, is_internal)
                 VALUES ($1, $2, $3, false)`,
                [requestId, userId, `Rejection reason: ${reason.trim()}`]
            );
        }

        // Notify requester
        const notifMsg = reason && reason.trim()
            ? `Your request #${updated.ticket_number} was rejected. Reason: ${reason.trim()}`
            : `Your request #${updated.ticket_number} has been rejected.`;

        await pool.query(
            `INSERT INTO request_notifications (user_id, request_id, message)
             VALUES ($1, $2, $3)`,
            [updated.created_by, requestId, notifMsg]
        );

        // Email requester
        const requester = await pool.query(
            'SELECT email FROM users WHERE id = $1', [updated.created_by]
        );
        if (requester.rows[0]?.email) {
            const reasonHtml = reason && reason.trim()
                ? `<p><strong>Reason:</strong> ${reason.trim()}</p>`
                : '';
            await sendEmail(
                requester.rows[0].email,
                `Request Rejected: ${updated.ticket_number}`,
                `<p>Your vehicle request #${updated.ticket_number} has been rejected.</p>
                 ${reasonHtml}
                 <a href="http://localhost:3000/dashboard.html">View your request</a>`
            );
        }

        res.json({ message: 'Request rejected', ticket: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/requests/:id/formdata
// Only category managers (service_permissions) can update form_data.
// ─────────────────────────────────────────────────────────────
router.put('/:id/formdata', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    const { form_data } = req.body;
    if (!form_data) return res.status(400).json({ message: 'form_data required' });

    try {
        const ticketRes = await pool.query(
            'SELECT category FROM service_requests WHERE id = $1', [requestId]
        );
        if (ticketRes.rows.length === 0) {
            return res.status(404).json({ message: 'Not found' });
        }

        const perms = await pool.query(
            'SELECT 1 FROM user_service_permissions WHERE user_id = $1 AND category = $2',
            [userId, ticketRes.rows[0].category]
        );
        if (perms.rows.length === 0) {
            return res.status(403).json({ message: 'Only category managers can update form data' });
        }

        await pool.query(
            'UPDATE service_requests SET form_data = $1, updated_at = NOW() WHERE id = $2',
            [form_data, requestId]
        );
        res.json({ message: 'Form data updated' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// PUT /api/requests/:id  — edit title / description
// Only the creator can edit, and only while status = pending_approval.
// ─────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    const { title, description } = req.body;

    try {
        const ticketRes = await pool.query(
            'SELECT created_by, status FROM service_requests WHERE id = $1', [requestId]
        );
        if (ticketRes.rows.length === 0) {
            return res.status(404).json({ message: 'Not found' });
        }
        if (ticketRes.rows[0].created_by !== userId) {
            return res.status(403).json({ message: 'Not your ticket' });
        }
        if (ticketRes.rows[0].status !== 'pending_approval') {
            return res.status(400).json({ message: 'Only pending tickets can be edited' });
        }

        await pool.query(
            'UPDATE service_requests SET title = $1, description = $2, updated_at = NOW() WHERE id = $3',
            [title, description, requestId]
        );
        res.json({ message: 'Updated' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/requests/:id
// Only the creator can delete, and only while status = pending_approval.
// ─────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const requestId = parseInt(req.params.id);
    try {
        const ticketRes = await pool.query(
            'SELECT created_by, status FROM service_requests WHERE id = $1', [requestId]
        );
        if (ticketRes.rows.length === 0) {
            return res.status(404).json({ message: 'Not found' });
        }
        if (ticketRes.rows[0].created_by !== userId) {
            return res.status(403).json({ message: 'Not your ticket' });
        }
        if (ticketRes.rows[0].status !== 'pending_approval') {
            return res.status(400).json({ message: 'Only pending tickets can be deleted' });
        }

        await pool.query('DELETE FROM service_requests WHERE id = $1', [requestId]);
        res.json({ message: 'Deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;