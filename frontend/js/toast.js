// Centered toast notification (middle of screen)
function showCenteredToast(message, type = 'success', duration = 3000) {
    // Remove existing overlay if any
    const existing = document.querySelector('.toast-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'toast-overlay';
    const icon = type === 'success' ? '✅' : '❌';
    overlay.innerHTML = `
        <div class="toast-box ${type}">
            <i>${icon}</i>
            <p>${message}</p>
            <button class="toast-btn">OK</button>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.classList.add('active');

    const btn = overlay.querySelector('.toast-btn');
    const close = () => {
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 300);
    };
    btn.addEventListener('click', close);
    if (duration) setTimeout(close, duration);
}