const API_BASE = 'http://localhost:5000/api';

function getToken() {
    return localStorage.getItem('token');
}

function getUser() {
    return JSON.parse(localStorage.getItem('user') || '{}');
}

async function apiCall(endpoint, options = {}) {
    const token = getToken();
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };
    if (token) {
        headers['x-auth-token'] = token;
    }
    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers
    });
    if (response.status === 401) {
        localStorage.clear();
        window.location.href = 'index.html';
        throw new Error('Session expired');
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Request failed');
    return data;
}

window.apiCall = apiCall;
window.getUser = getUser;
window.getToken = getToken;