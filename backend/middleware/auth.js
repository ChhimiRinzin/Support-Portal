const jwt = require('jsonwebtoken');

function getUserIdFromToken(req) {
    const token = req.header('x-auth-token');
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'raa_support_secret');
        return decoded.id;
    } catch (err) { return null; }
}

function authMiddleware(req, res, next) {
    const token = req.header('x-auth-token');
    if (!token) return res.status(401).json({ message: 'No token' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET || 'raa_support_secret');
        next();
    } catch (err) { res.status(401).json({ message: 'Invalid token' }); }
}

module.exports = { getUserIdFromToken, authMiddleware };