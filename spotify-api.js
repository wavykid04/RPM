async function apiCall(endpoint, method, accessToken, body = null) {
  const opts = { method, headers: { Authorization: `Bearer ${accessToken}` } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(`https://api.spotify.com/v1${endpoint}`, opts);
  if (res.status === 204) return true;
  if (!res.ok) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : true;
}

async function searchTrackId(title, artist, accessToken) {
  const q = encodeURIComponent(`track:${title} artist:${artist}`);
  const data = await apiCall(`/search?q=${q}&type=track&limit=1`, 'GET', accessToken);
  return data?.tracks?.items?.[0]?.id || null;
}

async function checkIfSaved(trackId, accessToken) {
  const data = await apiCall(`/me/tracks/contains?ids=${trackId}`, 'GET', accessToken);
  return Array.isArray(data) ? data[0] : false;
}

async function saveTrack(trackId, accessToken) {
  return apiCall(`/me/tracks?ids=${trackId}`, 'PUT', accessToken);
}

async function removeTrack(trackId, accessToken) {
  return apiCall(`/me/tracks?ids=${trackId}`, 'DELETE', accessToken);
}

module.exports = { searchTrackId, checkIfSaved, saveTrack, removeTrack };
