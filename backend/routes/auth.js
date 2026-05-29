const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { sendEmail } = require('../services/emailService');
const router = express.Router();

// ============== REGISTER ==============
router.post('/register', async (req, res) => {
    const { full_name, email, designation, division, password } = req.body;
    if (!full_name || !email || !password) return res.status(400).json({ message: 'Missing required fields' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be 6+ characters' });
    try {
        const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (exists.rows.length) return res.status(400).json({ message: 'Email already registered' });
        const hashed = await bcrypt.hash(password, 10);
        const result = await pool.query(
            `INSERT INTO users (username, full_name, email, designation, division, password_hash, role, is_asws_authorized)
             VALUES ($1, $2, $3, $4, $5, $6, 'staff', false)
             RETURNING id, full_name, email, designation, division`,
            [email.split('@')[0], full_name, email, designation, division, hashed]
        );
        const newUser = result.rows[0];

        if (email) {
            sendEmail(
                email,
                'Welcome to RAA Support Portal',
                `<h2>Welcome, ${full_name}!</h2>
                 <p>Your account has been successfully created.</p>
                 <p>You can now log in at <a href="http://localhost:3000/login.html">RAA Support Portal</a>.</p>
                 <p>If you did not request this, please ignore this email.</p>`
            ).catch(err => console.error('Welcome email error:', err));
        }

        res.status(201).json({ message: 'Registration successful', user: newUser });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// ============== LOGIN ==============
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

    // Hardcoded ICT manager
    if (email.toLowerCase() === 'chhimirinzin28@gmail.com' && password === 'ict123') {
        let userResult = await pool.query('SELECT * FROM users WHERE email = $1', ['chhimirinzin28@gmail.com']);
        let user;
        if (userResult.rows.length === 0) {
            const insertResult = await pool.query(
                `INSERT INTO users (username, full_name, email, password_hash, department, role, is_asws_authorized)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                ['ictmanager', 'ICT Manager', 'chhimirinzin28@gmail.com', 'dummy', 'ICT Department', 'manager', false]
            );
            user = insertResult.rows[0];
        } else {
            user = userResult.rows[0];
        }
        await pool.query(
            `INSERT INTO user_service_permissions (user_id, category) VALUES ($1, 'ict') ON CONFLICT DO NOTHING`,
            [user.id]
        );
        await pool.query(
            `INSERT INTO category_assignments (category, fallback_user_id) VALUES ('ict', $1) ON CONFLICT (category) DO UPDATE SET fallback_user_id = EXCLUDED.fallback_user_id`,
            [user.id]
        );
        const permCheck = await pool.query('SELECT 1 FROM user_service_permissions WHERE user_id = $1 LIMIT 1', [user.id]);
        const isManager = permCheck.rows.length > 0;
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role, can_handle_repair: user.can_handle_repair || false, is_manager: isManager },
            process.env.JWT_SECRET || 'raa_support_secret',
            { expiresIn: '7d' }
        );
        return res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                role: user.role,
                can_handle_repair: user.can_handle_repair || false,
                is_asws_authorized: user.is_asws_authorized || false,
                is_manager: isManager
            }
        });
    }

    // Hardcoded AIMS manager
    if (email.toLowerCase() === 'migmad@bhutanaudit.gov.bt' && password === 'migma123') {
        let userResult = await pool.query('SELECT * FROM users WHERE email = $1', ['migmad@bhutanaudit.gov.bt']);
        let user;
        if (userResult.rows.length === 0) {
            const insertResult = await pool.query(
                `INSERT INTO users (username, full_name, email, password_hash, department, role, is_asws_authorized)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                ['migmad', 'AIMS Manager', 'migmad@bhutanaudit.gov.bt', 'dummy', 'AIMS Department', 'manager', false]
            );
            user = insertResult.rows[0];
        } else {
            user = userResult.rows[0];
        }
        await pool.query(
            `INSERT INTO user_service_permissions (user_id, category) VALUES ($1, 'aims') ON CONFLICT DO NOTHING`,
            [user.id]
        );
        await pool.query(
            `INSERT INTO category_assignments (category, fallback_user_id) VALUES ('aims', $1) ON CONFLICT (category) DO UPDATE SET fallback_user_id = EXCLUDED.fallback_user_id`,
            [user.id]
        );
        const permCheck = await pool.query('SELECT 1 FROM user_service_permissions WHERE user_id = $1 LIMIT 1', [user.id]);
        const isManager = permCheck.rows.length > 0;
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role, can_handle_repair: user.can_handle_repair || false, is_manager: isManager },
            process.env.JWT_SECRET || 'raa_support_secret',
            { expiresIn: '7d' }
        );
        return res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                role: user.role,
                can_handle_repair: user.can_handle_repair || false,
                is_asws_authorized: user.is_asws_authorized || false,
                is_manager: isManager
            }
        });
    }

    // Hardcoded ADM (Administrative Officer)
    if (email.toLowerCase() === 'adm@bhutanaudit.gov.bt' && password === 'adm123') {
        let userResult = await pool.query('SELECT * FROM users WHERE email = $1', ['adm@bhutanaudit.gov.bt']);
        let user;
        if (userResult.rows.length === 0) {
            const insertResult = await pool.query(
                `INSERT INTO users (username, full_name, email, password_hash, department, role, is_asws_authorized)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                ['adm_user', 'Administrative Officer', 'adm@bhutanaudit.gov.bt', 'dummy', 'Administration', 'manager', false]
            );
            user = insertResult.rows[0];
        } else {
            user = userResult.rows[0];
        }
        await pool.query(
            `INSERT INTO user_service_permissions (user_id, category) VALUES ($1, 'vehicle') ON CONFLICT DO NOTHING`,
            [user.id]
        );
        await pool.query(
            `INSERT INTO category_assignments (category, fallback_user_id) VALUES ('vehicle', $1) ON CONFLICT (category) DO UPDATE SET fallback_user_id = EXCLUDED.fallback_user_id`,
            [user.id]
        );
        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role, is_manager: true },
            process.env.JWT_SECRET || 'raa_support_secret',
            { expiresIn: '7d' }
        );
        return res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                role: user.role,
                is_manager: true
            }
        });
    }

    // Regular database user login
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });
        const user = result.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(401).json({ message: 'Invalid credentials' });

        const permCheck = await pool.query('SELECT 1 FROM user_service_permissions WHERE user_id = $1 LIMIT 1', [user.id]);
        const isManager = permCheck.rows.length > 0;

        const token = jwt.sign(
            { id: user.id, email: user.email, can_handle_repair: user.can_handle_repair || false, is_manager: isManager },
            process.env.JWT_SECRET || 'raa_support_secret',
            { expiresIn: '7d' }
        );
        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                can_handle_repair: user.can_handle_repair || false,
                is_asws_authorized: user.is_asws_authorized || false,
                is_manager: isManager
            }
        });
    } catch (err) { res.status(500).json({ message: err.message }); }
});

// ============== CHANGE PASSWORD ==============
router.put('/change-password', async (req, res) => {
    const token = req.header('x-auth-token');
    if (!token) return res.status(401).json({ message: 'No token, authorization denied' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;
        const { new_password, confirm_password } = req.body;

        if (!new_password || !confirm_password) {
            return res.status(400).json({ message: 'Both password fields are required' });
        }
        if (new_password !== confirm_password) {
            return res.status(400).json({ message: 'Passwords do not match' });
        }
        if (new_password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters' });
        }

        const hashed = await bcrypt.hash(new_password, 10);
        await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hashed, userId]);

        const userRes = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length && userRes.rows[0].email) {
            const userEmail = userRes.rows[0].email;
            const fullName = userRes.rows[0].full_name;
            sendEmail(
                userEmail,
                'Your password has been changed',
                `<h2>Password changed</h2>
                 <p>Hello ${fullName},</p>
                 <p>Your RAA Support Portal password was successfully changed.</p>
                 <p>If you did not perform this action, please contact the system administrator immediately.</p>`
            ).catch(err => console.error('Password change email error:', err));
        }

        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ============== GET CURRENT USER ==============
router.get('/me', async (req, res) => {
    const token = req.header('x-auth-token');
    if (!token) return res.status(401).json({ message: 'No token' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await pool.query('SELECT id, full_name, email, designation, division, can_handle_repair, is_asws_authorized FROM users WHERE id = $1', [decoded.id]);
        if (!user.rows.length) return res.status(404).json({ message: 'User not found' });
        res.json(user.rows[0]);
    } catch (err) { res.status(401).json({ message: 'Invalid token' }); }
});

module.exports = router;