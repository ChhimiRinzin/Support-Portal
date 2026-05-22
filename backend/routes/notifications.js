const express = require('express');
const router = express.Router();
const pool = require('../db');
const { getUserIdFromToken } = require('../middleware/auth');

// GET unread notifications for current user
router.get('/', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    try {
        const result = await pool.query(
            `SELECT n.*, r.ticket_number 
             FROM request_notifications n
             JOIN service_requests r ON n.request_id = r.id
             WHERE n.user_id = $1 AND n.is_read = false
             ORDER BY n.created_at DESC`,
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Mark notifications as read
router.post('/mark-read', async (req, res) => {
    const userId = getUserIdFromToken(req);
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });
    const { notification_ids } = req.body;
    try {
        if (notification_ids && notification_ids.length) {
            await pool.query(
                `UPDATE request_notifications SET is_read = true 
                 WHERE id = ANY($1::int[]) AND user_id = $2`,
                [notification_ids, userId]
            );
        } else {
            await pool.query(
                `UPDATE request_notifications SET is_read = true WHERE user_id = $1`,
                [userId]
            );
        }
        res.json({ message: 'Marked read' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;