function getStoredToken() {
    return localStorage.getItem('token');
}

function clearAuth() {
    localStorage.removeItem('token');
    localStorage.removeItem('tokenExpiry');
    localStorage.removeItem('userID');
    localStorage.removeItem('myReferralCode');
    localStorage.removeItem('userData');
}

function saveAuth(data) {
    if (!data || !data.token) return false;
    const expiry = Date.now() + 24 * 60 * 60 * 1000;
    localStorage.setItem('token', data.token);
    localStorage.setItem('tokenExpiry', String(expiry));
    if (data.userID) localStorage.setItem('userID', data.userID);
    if (data.myReferralCode) localStorage.setItem('myReferralCode', data.myReferralCode);
    if (data.user) localStorage.setItem('userData', JSON.stringify(data.user));
    return true;
}

function isSessionValid() {
    const token = getStoredToken();
    const expiry = Number(localStorage.getItem('tokenExpiry') || 0);
    if (!token || !expiry) return false;
    if (Date.now() > expiry) {
        clearAuth();
        return false;
    }
    return true;
}

function requireAuth(redirectTo = 'login.html') {
    if (!isSessionValid()) {
        window.location.href = redirectTo;
        return false;
    }
    return true;
}

function addAuthHeader(headers = {}) {
    const token = getStoredToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

function logout() {
    clearAuth();
    alert('Signed Out!');
    window.location.href = 'login.html';
}
