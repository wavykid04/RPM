const crypto = require('crypto');
const http = require('http');
const { shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TOKEN_PATH = path.join(os.homedir(), '.spotify-widget-token.json');
const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = 'user-library-read user-library-modify';

function loadToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch (e) {}
  return null;
}

function saveToken(token) {
  token.expires_at = Date.now() + token.expires_in * 1000;
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
}

async function refreshAccessToken(clientId, refreshTok) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshTok, client_id: clientId })
  });
  const data = await res.json();
  if (!data.access_token) return null;
  const merged = { ...data, refresh_token: data.refresh_token || refreshTok };
  saveToken(merged);
  return merged;
}

async function getValidToken(clientId) {
  let token = loadToken();
  if (!token) return null;
  if (Date.now() > token.expires_at - 60000) token = await refreshAccessToken(clientId, token.refresh_token);
  return token;
}

function authenticate(clientId) {
  return new Promise((resolve, reject) => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('scope', SCOPES);

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== '/callback') return;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif;padding:40px"><h2>✓ Connected! You can close this tab.</h2></body></html>');
      server.close();

      const code = url.searchParams.get('code');
      if (!code) { reject(new Error('No auth code')); return; }

      const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier })
      });
      const tokenData = await tokenRes.json();
      if (tokenData.access_token) { saveToken(tokenData); resolve(tokenData); }
      else reject(new Error('Token exchange failed: ' + JSON.stringify(tokenData)));
    });

    server.listen(REDIRECT_PORT, () => shell.openExternal(authUrl.toString()));
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('Auth timeout')); }, 120000);
  });
}

module.exports = { authenticate, getValidToken, loadToken };
