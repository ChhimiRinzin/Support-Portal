const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// Import routes
const authRoutes = require('./routes/auth');
const requestRoutes = require('./routes/requests');
const notificationRoutes = require('./routes/notifications');
const driverRoutes = require('./routes/drivers');

// Use routes
app.use('/api/auth', authRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/drivers', driverRoutes);

// Test route
app.get('/api/test', (req, res) => res.json({ message: 'API working' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));