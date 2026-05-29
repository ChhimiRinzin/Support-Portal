async function generateTicketNumber(category, pool) {
    const year = new Date().getFullYear();
    
    // Map category to prefix (3 letters)
    const prefixMap = {
        repair: 'RPR',
        ict: 'ICT',
        vehicle: 'VEH',
        aims: 'AIM',
        asws_membership: 'ASW',
        asws_loan: 'ASL',
        goods: 'GDS'
    };
    const prefix = prefixMap[category] || category.substring(0, 3).toUpperCase();
    
    // Get the highest ticket number for this prefix and year
    const pattern = `${prefix}-${year}-%`;
    const result = await pool.query(
        `SELECT ticket_number FROM service_requests 
         WHERE ticket_number LIKE $1 
         ORDER BY ticket_number DESC 
         LIMIT 1`,
        [pattern]
    );
    
    let nextNumber = 1;
    if (result.rows.length > 0) {
        const lastTicket = result.rows[0].ticket_number;
        const parts = lastTicket.split('-');
        const lastNum = parseInt(parts[2], 10);
        if (!isNaN(lastNum)) nextNumber = lastNum + 1;
    }
    
    const paddedNumber = nextNumber.toString().padStart(4, '0');
    return `${prefix}-${year}-${paddedNumber}`;
}

module.exports = { generateTicketNumber };