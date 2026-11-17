// Shared API origin for local development and static frontend deployments.
// Replace the production placeholder with the URL of the deployed Render service.
const API_BASE_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:'
  ? 'http://localhost:5000'
  : 'https://twende-events-backend.onrender.com';

// Resolve relative uploads against the API and upgrade legacy localhost URLs
// already stored in the database when the frontend is deployed.
function apiAssetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, API_BASE_URL);
    const isLegacyLocalUpload = ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.port === '5000'
      && API_BASE_URL !== 'http://localhost:5000';
    if (isLegacyLocalUpload) return `${API_BASE_URL}${url.pathname}${url.search}${url.hash}`;
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}
