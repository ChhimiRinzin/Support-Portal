async function generateTicketNumber(category, pool) {
    const year = new Date().getFullYear();
    const prefix = category.substring(0, 3).toUpperCase();
    const result = await pool.query(
        `SELECT COUNT(*) FROM service_requests WHERE category = $1 AND EXTRACT(YEAR FROM created_at) = $2`,
        [category, year]
    );
    const nextNum = (parseInt(result.rows[0].count) + 1).toString().padStart(4, '0');
    return `${prefix}-${year}-${nextNum}`;
}
module.exports = { generateTicketNumber };