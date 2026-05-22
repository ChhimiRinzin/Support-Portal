function initNotificationBell() {
    const bell = document.getElementById('notificationBell');
    if (!bell) return;
    async function updateCount() {
        try {
            const notifs = await apiCall('/notifications');
            const count = notifs.length;
            const badge = bell.querySelector('.badge');
            if (badge) {
                badge.textContent = count;
                badge.style.display = count ? 'inline-flex' : 'none';
            }
        } catch(e) {}
    }
    bell.addEventListener('click', async () => {
        const notifs = await apiCall('/notifications');
        if (!notifs.length) { alert('No notifications'); return; }
        let msg = 'Notifications:\n';
        notifs.forEach(n => msg += `- ${n.message}\n`);
        if (confirm(msg + '\nMark all as read?')) {
            await apiCall('/notifications/mark-read', { method: 'POST' });
            updateCount();
        }
    });
    updateCount();
    setInterval(updateCount, 30000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initNotificationBell);
else initNotificationBell();