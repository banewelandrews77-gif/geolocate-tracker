// Parse Channel ID from URL path (e.g. /track/ABC123)
const pathParts = window.location.pathname.split('/');
let channelId = pathParts[pathParts.length - 1];

// Fallback: If not in path, check query parameters (e.g. ?channel=ABC123)
if (!channelId || channelId === 'tracker.html') {
  const urlParams = new URLSearchParams(window.location.search);
  channelId = urlParams.get('channel') || 'DEMO';
}

channelId = channelId.toUpperCase();
document.getElementById('channel-key').textContent = channelId;

// State management
let ws = null;
let watchId = null;
let isTracking = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
let isTabVisible = true;

// DOM Elements
const socketDot = document.getElementById('socket-status-dot');
const socketText = document.getElementById('socket-status-text');
const trackingBtn = document.getElementById('btn-toggle-tracking');
const consentModal = document.getElementById('consent-modal');
const modalGrantBtn = document.getElementById('btn-modal-grant');
const modalCancelBtn = document.getElementById('btn-modal-cancel');
const powerStatusText = document.getElementById('power-mode-status');
const manualInput = document.getElementById('manual-location-input');
const btnManual = document.getElementById('btn-set-manual-location');

const valLat = document.getElementById('val-latitude');
const valLng = document.getElementById('val-longitude');
const valSpeed = document.getElementById('val-speed');
const valAcc = document.getElementById('val-accuracy');

// Toast Utility
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'fa-info-circle';
  if (type === 'success') icon = 'fa-check-circle';
  if (type === 'error') icon = 'fa-exclamation-triangle';
  
  toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.3s reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Format coordinates helper
function formatCoord(val) {
  return typeof val === 'number' ? val.toFixed(6) : '-';
}

// Copy link handler
document.getElementById('btn-copy-link').addEventListener('click', () => {
  const viewerUrl = `${window.location.protocol}//${window.location.host}/view/${channelId}`;
  navigator.clipboard.writeText(viewerUrl)
    .then(() => showToast('Viewer link copied to clipboard!', 'success'))
    .catch(() => showToast('Failed to copy link. Please manually copy the URL.', 'error'));
});

// Setup WebSocket Connection
function connectSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socketUrl = `${protocol}//${window.location.host}`;
  
  socketDot.className = 'status-dot connecting';
  socketText.textContent = 'Connecting...';
  
  ws = new WebSocket(socketUrl);

  ws.onopen = () => {
    reconnectAttempts = 0;
    socketDot.className = 'status-dot online';
    socketText.textContent = 'Connected';
    showToast('Telemetry link established.', 'success');
    
    // Register tracker
    ws.send(JSON.stringify({
      type: 'register',
      role: 'tracker',
      channelId: channelId
    }));
    
    trackingBtn.disabled = false;
    btnManual.disabled = false;
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'error') {
        showToast(data.message, 'error');
      }
    } catch (e) {
      console.error('Error parsing WS message:', e);
    }
  };

  ws.onclose = () => {
    socketDot.className = 'status-dot offline';
    socketText.textContent = 'Disconnected';
    trackingBtn.disabled = true;
    btnManual.disabled = true;
    
    if (isTracking) {
      stopGPS();
      showToast('Connection lost. Location sharing paused.', 'error');
    }
    
    // Attempt reconnect with exponential backoff
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      const timeout = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
      showToast(`Reconnection attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${(timeout/1000).toFixed(0)}s...`, 'info');
      setTimeout(connectSocket, timeout);
    } else {
      showToast('WebSocket connection failed. Please refresh the page.', 'error');
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket Error:', err);
  };
}

// Start GPS Tracking
function startGPS() {
  if (!('geolocation' in navigator)) {
    showToast('Your browser does not support Geolocation.', 'error');
    return;
  }

  isTracking = true;
  trackingBtn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop Streaming';
  trackingBtn.className = 'btn btn-secondary';
  powerStatusText.textContent = 'STREAMING (ACTIVE)';
  powerStatusText.style.color = 'var(--color-primary)';
  
  const options = {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 10000
  };

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const { latitude, longitude, accuracy, speed, heading } = position.coords;
      
      // Update UI displays
      valLat.textContent = formatCoord(latitude);
      valLng.textContent = formatCoord(longitude);
      valAcc.textContent = accuracy ? `${accuracy.toFixed(1)} m` : '-';
      valSpeed.textContent = typeof speed === 'number' && speed >= 0 ? `${(speed * 3.6).toFixed(1)} km/h` : '0.0 km/h';

      // Send telemetry via socket
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'telemetry',
          latitude,
          longitude,
          timestamp: position.timestamp || Date.now(),
          accuracy,
          speed: typeof speed === 'number' ? speed : 0
        }));
      }
    },
    (error) => {
      console.error('Geolocation error:', error);
      let errMsg = 'Unable to retrieve location details.';
      if (error.code === error.PERMISSION_DENIED) {
        errMsg = 'GPS permission denied by browser settings.';
        stopGPS();
      } else if (error.code === error.TIMEOUT) {
        errMsg = 'GPS connection timed out. Retrying...';
      }
      showToast(errMsg, 'error');
    },
    options
  );
}

// Stop GPS Tracking
function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  isTracking = false;
  trackingBtn.innerHTML = '<i class="fa-solid fa-play"></i> Start Streaming';
  trackingBtn.className = 'btn btn-primary';
  powerStatusText.textContent = 'STANDBY';
  powerStatusText.style.color = 'var(--color-success)';
  
  // Clear stat displays
  valLat.textContent = '-';
  valLng.textContent = '-';
  valSpeed.textContent = '-';
  valAcc.textContent = '-';
}

// Visibility change handler (Power Optimization)
function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    isTabVisible = false;
    if (isTracking) {
      // Temporarily clear watch but keep tracking status as true so we resume
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      powerStatusText.textContent = 'POWER SAVE (STANDBY)';
      powerStatusText.style.color = 'var(--color-warning)';
      showToast('Tab minimized. Geolocation suspended to save battery.', 'info');
    }
  } else {
    isTabVisible = true;
    if (isTracking && watchId === null) {
      startGPS();
      showToast('Tab focused. Resuming live telemetry stream.', 'success');
    }
  }
}

// Initialize button click flow
trackingBtn.addEventListener('click', () => {
  if (isTracking) {
    stopGPS();
    showToast('Location stream terminated.', 'info');
  } else {
    // Show contextual permission modal before calling native Geolocation prompt
    consentModal.classList.add('active');
    consentModal.setAttribute('aria-hidden', 'false');
  }
});

// Modal Actions
modalGrantBtn.addEventListener('click', () => {
  consentModal.classList.remove('active');
  consentModal.setAttribute('aria-hidden', 'true');
  startGPS();
});

modalCancelBtn.addEventListener('click', () => {
  consentModal.classList.remove('active');
  consentModal.setAttribute('aria-hidden', 'true');
  showToast('GPS initialization cancelled.', 'info');
});

// Send Mock / Geocoded Telemetry
function sendMockTelemetry(latitude, longitude, accuracy = 10, label = "Manual Input") {
  // Update UI displays
  valLat.textContent = formatCoord(latitude);
  valLng.textContent = formatCoord(longitude);
  valAcc.textContent = accuracy ? `${accuracy.toFixed(1)} m` : '-';
  valSpeed.textContent = '0.0 km/h';

  // Send telemetry via socket
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'telemetry',
      latitude,
      longitude,
      timestamp: Date.now(),
      accuracy,
      speed: 0
    }));
    
    powerStatusText.textContent = `MANUAL (${label.substring(0, 15)})`;
    powerStatusText.style.color = 'var(--color-primary)';
  } else {
    showToast('Failed to send. WebSocket disconnected.', 'error');
  }
}

// Coordinate Parser to handle space/comma separated decimal degrees and cardinal directions
function parseCoordinates(str) {
  const cleanStr = str.replace(/°/g, '').trim();
  const numRegex = /([-+]?\d+(?:\.\d+)?)\s*([NSEW])?/gi;
  const matches = [...cleanStr.matchAll(numRegex)];
  
  if (matches.length === 2) {
    let lat = parseFloat(matches[0][1]);
    const latDir = matches[0][2];
    
    let lng = parseFloat(matches[1][1]);
    const lngDir = matches[1][2];
    
    if (latDir) {
      const dir = latDir.toUpperCase();
      if (dir === 'S') lat = -lat;
    }
    if (lngDir) {
      const dir = lngDir.toUpperCase();
      if (dir === 'W') lng = -lng;
    }
    
    if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
      return { lat, lng };
    }
  }
  return null;
}

// Manual Location Form Handler
btnManual.addEventListener('click', () => {
  const queryText = manualInput.value.trim();
  if (!queryText) {
    showToast('Please enter an address or GPS coordinates.', 'error');
    return;
  }

  const coords = parseCoordinates(queryText);
  const ghanaPostRegex = /^[a-z]{2}-\d{3,5}-\d{4}$/i;

  if (coords) {
    stopGPS();
    sendMockTelemetry(coords.lat, coords.lng, 10, "Manual Coords");
    showToast(`Location set to: ${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`, 'success');
  } else if (ghanaPostRegex.test(queryText)) {
    btnManual.disabled = true;
    btnManual.textContent = 'Searching...';
    
    fetch('/api/geocode-ghana', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ address: queryText })
    })
    .then(res => {
      if (!res.ok) throw new Error('GhanaPost API error');
      return res.json();
    })
    .then(data => {
      btnManual.disabled = false;
      btnManual.innerHTML = '<i class="fa-solid fa-map-pin"></i> Update';
      
      if (data && data.found && data.data && data.data.Table && data.data.Table.length > 0) {
        const row = data.data.Table[0];
        const lat = parseFloat(row.CenterLatitude);
        const lon = parseFloat(row.CenterLongitude);
        const area = row.Area || queryText;
        
        stopGPS();
        sendMockTelemetry(lat, lon, 5, `GP: ${queryText}`);
        showToast(`Resolved Digital Address: ${area}`, 'success');
      } else {
        showToast('Digital Address not found in GhanaPost database.', 'error');
      }
    })
    .catch(err => {
      btnManual.disabled = false;
      btnManual.innerHTML = '<i class="fa-solid fa-map-pin"></i> Update';
      showToast('GhanaPost digital address lookup failed.', 'error');
      console.error(err);
    });
  } else {
    // Treat as address and geocode
    btnManual.disabled = true;
    btnManual.textContent = 'Searching...';
    
    const geocodeUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(queryText)}&format=json&limit=1`;
    
    fetch(geocodeUrl, {
      headers: {
        'User-Agent': 'GeoLocateTracker/1.0 (contact: andy@example.com)'
      }
    })
    .then(res => {
      if (!res.ok) throw new Error('Geocoding network response error');
      return res.json();
    })
    .then(data => {
      btnManual.disabled = false;
      btnManual.innerHTML = '<i class="fa-solid fa-map-pin"></i> Update';
      
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        const displayName = data[0].display_name;
        
        stopGPS();
        sendMockTelemetry(lat, lon, 15, displayName);
        showToast(`Resolved: ${data[0].name || queryText}`, 'success');
      } else {
        showToast('Location not found. Try adding city/country.', 'error');
      }
    })
    .catch(err => {
      btnManual.disabled = false;
      btnManual.innerHTML = '<i class="fa-solid fa-map-pin"></i> Update';
      showToast('Geocoding error. Check your connection.', 'error');
      console.error('Geocoding failure:', err);
    });
  }
});

// Trigger manual input update on pressing Enter
manualInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    btnManual.click();
  }
});

// Bind visibility listeners
document.addEventListener('visibilitychange', handleVisibilityChange);
window.addEventListener('pagehide', () => {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
  }
});

// Connect to Websockets on start
connectSocket();
