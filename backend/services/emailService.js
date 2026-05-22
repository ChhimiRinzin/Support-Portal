const nodemailer = require('nodemailer');
let transporter = null;

function initTransporter() {
    if (!process.env.EMAIL_HOST) return null;
    try {
        transporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST,
            port: parseInt(process.env.EMAIL_PORT),
            secure: process.env.EMAIL_SECURE === 'true',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });
        // Verify connection (optional)
        transporter.verify().catch(err => console.warn('SMTP verify failed:', err.message));
        return transporter;
    } catch (err) {
        console.warn('Failed to create email transporter:', err.message);
        return null;
    }
}

async function sendEmail(to, subject, html) {
    if (!process.env.EMAIL_HOST) return;
    if (!transporter) initTransporter();
    if (!transporter) {
        console.warn('Email not sent – transporter not available');
        return;
    }
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_FROM,
            to,
            subject,
            html,
        });
        console.log(`📧 Email sent to ${to}`);
    } catch (err) {
        console.error('Email error:', err.message);
    }
}

module.exports = { sendEmail };