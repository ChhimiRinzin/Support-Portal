const express = require('express');
const router = express.Router();
const pool = require('../db');

router.get('/', async (req, res) => {
    try {
        // Include vehicle_name for the dropdowns
        const result = await pool.query(
            'SELECT id, name, vehicle_name, vehicle_number, phone FROM drivers WHERE active = true ORDER BY name'
        );
        res.json({ drivers: result.rows });
    } catch (error) {
        console.error('Database error in /api/drivers:', error);
        res.status(500).json({ message: 'Database error: ' + error.message });
    }
});

module.exports = router;