// Parse Channel ID from URL path (e.g. /view/ABC123)
const pathParts = window.location.pathname.split('/');
let channelId = pathParts[pathParts.length - 1];

// Fallback: Check query parameters (e.g. ?channel=ABC123)
if (!channelId || channelId === 'viewer.html') {
  const urlParams = new URLSearchParams(window.location.search);
  channelId = urlParams.get('channel') || 'DEMO';
}

channelId = channelId.toUpperCase();
document.getElementById('channel-key-label').textContent = channelId;

// State management
let ws = null;
let map = null;
let hostMarker = null;
let pathPolyline = null;
let pathCoordinates = [];
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
let routingControl = null;
let viewerLocation = null;
let trackerLocation = null;
let isRoutingActive = false;
let viewerMarker = null;
let viewerWatchId = null;

// DOM Elements
const socketDot = document.getElementById('socket-status-dot');
const socketText = document.getElementById('socket-status-text');
const hostStatus = document.getElementById('tracker-host-status');
const valLat = document.getElementById('val-latitude');
const valLng = document.getElementById('val-longitude');
const valSpeed = document.getElementById('val-speed');
const valAcc = document.getElementById('val-accuracy');
const valTime = document.getElementById('val-timestamp');
const valTotal = document.getElementById('val-total-points');
const autoCenterChk = document.getElementById('chk-auto-center');
const btnToggleRouting = document.getElementById('btn-toggle-routing');
const routingDetails = document.getElementById('routing-details-container');
const btnToggleDirections = document.getElementById('btn-toggle-directions');
const directionsListContainer = document.getElementById('directions-list-container');
const directionsList = document.getElementById('directions-list');
const valRoutingTime = document.getElementById('val-routing-time');
const valRoutingDistance = document.getElementById('val-routing-distance');

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

// Format coordinates and stats
function formatCoord(val) {
  return typeof val === 'number' ? val.toFixed(6) : '-';
}

// Initialise Leaflet Map
function initMap() {
  // Set default view (centered around equator/ocean if empty, zoomed out)
  map = L.map('map', {
    zoomControl: false,
    zoomSnap: 0.5
  }).setView([0, 0], 2);

  // Elegant dark map style from CartoDB
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  // Add zoom control manually in bottom right
  L.control.zoom({
    position: 'bottomright'
  }).addTo(map);

  // Initialize path trace polyline
  pathPolyline = L.polyline([], {
    color: '#8B5CF6',
    weight: 4,
    opacity: 0.8,
    lineJoin: 'round'
  }).addTo(map);
}

// Update Map Marker & Polyline
function updateMapLocation(lat, lng, accuracy) {
  const position = [lat, lng];
  trackerLocation = position;

  // Update path trail coordinates
  pathCoordinates.push(position);
  pathPolyline.setLatLngs(pathCoordinates);
  
  valTotal.textContent = pathCoordinates.length;

  if (isRoutingActive && routingControl && viewerLocation) {
    routingControl.setWaypoints([
      L.latLng(viewerLocation[0], viewerLocation[1]),
      L.latLng(lat, lng)
    ]);
  }

  // Custom pulsing marker icon
  const pulsingIcon = L.divIcon({
    className: 'pulse-marker',
    html: '<div class="pulse-ring"></div><div class="pulse-core"></div>',
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });

  if (!hostMarker) {
    // Create new marker
    hostMarker = L.marker(position, { icon: pulsingIcon }).addTo(map);
    
    // Zoom in on first signal
    map.setView(position, 16);
  } else {
    // Move existing marker
    hostMarker.setLatLng(position);
    
    // Smooth auto-centering
    if (autoCenterChk.checked) {
      map.panTo(position);
    }
  }
}

// Populate coordinates history
function populateHistory(historyList) {
  if (!Array.isArray(historyList) || historyList.length === 0) return;

  // Clear existing paths
  pathCoordinates = [];
  
  // Extract coordinates in [lat, lng] format
  historyList.forEach((point) => {
    pathCoordinates.push([point.latitude, point.longitude]);
  });

  pathPolyline.setLatLngs(pathCoordinates);
  valTotal.textContent = pathCoordinates.length;

  // Draw last point as current position
  const lastPoint = historyList[historyList.length - 1];
  updateTelemetryUI(lastPoint);
  
  const position = [lastPoint.latitude, lastPoint.longitude];
  trackerLocation = position;
  
  // Custom pulsing marker
  const pulsingIcon = L.divIcon({
    className: 'pulse-marker',
    html: '<div class="pulse-ring"></div><div class="pulse-core"></div>',
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });

  if (hostMarker) {
    hostMarker.setLatLng(position);
  } else {
    hostMarker = L.marker(position, { icon: pulsingIcon }).addTo(map);
  }

  // Set map view around the last known position
  map.setView(position, 16);
}

// Update UI panel values
function updateTelemetryUI(data) {
  valLat.textContent = formatCoord(data.latitude);
  valLng.textContent = formatCoord(data.longitude);
  
  valAcc.textContent = data.accuracy ? `${data.accuracy.toFixed(1)} m` : 'N/A';
  valSpeed.textContent = typeof data.speed === 'number' && data.speed >= 0 ? `${(data.speed * 3.6).toFixed(1)} km/h` : '0.0 km/h';
  
  const time = new Date(data.timestamp);
  valTime.textContent = time.toLocaleTimeString();
}

// Setup WebSocket connection
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
    showToast('Viewing session active.', 'success');
    
    // Register viewer
    ws.send(JSON.stringify({
      type: 'register',
      role: 'viewer',
      channelId: channelId
    }));
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      switch (data.type) {
        case 'telemetry':
          updateTelemetryUI(data);
          updateMapLocation(data.latitude, data.longitude, data.accuracy);
          break;
          
        case 'history':
          populateHistory(data.history);
          showToast(`Retrieved ${data.history.length} location history data points.`, 'info');
          break;
          
        case 'tracker_status':
          if (data.online) {
            hostStatus.textContent = 'ACTIVE STREAMING';
            hostStatus.style.color = 'var(--color-success)';
            showToast('Tracker host is online and active.', 'success');
          } else {
            hostStatus.textContent = 'OFFLINE';
            hostStatus.style.color = 'var(--color-error)';
            showToast('Tracker host went offline.', 'warning');
          }
          break;
          
        case 'error':
          showToast(data.message, 'error');
          break;
      }
    } catch (e) {
      console.error('Error parsing WS message:', e);
    }
  };

  ws.onclose = () => {
    socketDot.className = 'status-dot offline';
    socketText.textContent = 'Disconnected';
    hostStatus.textContent = 'OFFLINE';
    hostStatus.style.color = 'var(--color-error)';
    
    // Auto-reconnect with exponential backoff
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      const timeout = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
      showToast(`Reconnection attempt ${reconnectAttempts}/${maxReconnectAttempts} in ${(timeout/1000).toFixed(0)}s...`, 'info');
      setTimeout(connectSocket, timeout);
    } else {
      showToast('WebSocket connection terminated. Please reload.', 'error');
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket Error:', err);
  };
}

// Clear local trace button
document.getElementById('btn-clear-path').addEventListener('click', () => {
  if (pathPolyline) {
    pathPolyline.setLatLngs([]);
  }
  if (hostMarker) {
    map.removeLayer(hostMarker);
    hostMarker = null;
  }
  pathCoordinates = [];
  valTotal.textContent = '0';
  valLat.textContent = '-';
  valLng.textContent = '-';
  valSpeed.textContent = '-';
  valAcc.textContent = '-';
  valTime.textContent = '-';
  showToast('Map path cleared locally.', 'info');
});

// Map Local Search Functionality
const searchInput = document.getElementById('map-search-input');
const btnSearch = document.getElementById('btn-map-search');

btnSearch.addEventListener('click', () => {
  const query = searchInput.value.trim();
  if (!query) {
    showToast('Please type an address to search.', 'error');
    return;
  }

  btnSearch.disabled = true;
  
  const ghanaPostRegex = /^[a-z]{2}-\d{3,5}-\d{4}$/i;

  if (ghanaPostRegex.test(query)) {
    fetch('/api/geocode-ghana', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ address: query })
    })
    .then(res => {
      if (!res.ok) throw new Error('GhanaPost API error');
      return res.json();
    })
    .then(data => {
      btnSearch.disabled = false;
      if (data && data.found && data.data && data.data.Table && data.data.Table.length > 0) {
        const row = data.data.Table[0];
        const lat = parseFloat(row.CenterLatitude);
        const lon = parseFloat(row.CenterLongitude);
        const area = row.Area || query;
        
        map.setView([lat, lon], 16);
        
        L.circleMarker([lat, lon], {
          color: '#3B82F6',
          fillColor: '#3B82F6',
          fillOpacity: 0.4,
          weight: 3,
          radius: 12
        }).addTo(map)
          .bindPopup(`<b>Digital Address:</b><br>${query}<br><span style="color: var(--text-muted); font-size: 0.8rem;">${area}</span>`)
          .openPopup();
          
        showToast(`Found Digital Address: ${area}`, 'success');
      } else {
        showToast('Digital Address not found.', 'error');
      }
    })
    .catch(err => {
      btnSearch.disabled = false;
      showToast('Search request failed.', 'error');
      console.error(err);
    });
  } else {
    // Geocode address
    fetch(`https://unpkg.com/leaflet@1.9.4/dist/leaflet.js` && `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`, {
      headers: {
        'User-Agent': 'GeoLocateViewer/1.0 (contact: andy@example.com)'
      }
    })
    .then(res => {
      if (!res.ok) throw new Error('Search network error');
      return res.json();
    })
    .then(data => {
      btnSearch.disabled = false;
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        
        // Move map view to search results
        map.setView([lat, lon], 14);
        
        // Draw a custom search marker matching our primary color scheme
        const searchMarker = L.circleMarker([lat, lon], {
          color: '#3B82F6',
          fillColor: '#3B82F6',
          fillOpacity: 0.4,
          weight: 3,
          radius: 12
        }).addTo(map)
          .bindPopup(`<b>Search Result:</b><br>${data[0].name || query}`)
          .openPopup();
        
        showToast(`Found: ${data[0].name || query}`, 'success');
      } else {
        showToast('Address not found.', 'error');
      }
    })
    .catch(err => {
      btnSearch.disabled = false;
      showToast('Search request failed.', 'error');
      console.error(err);
    });
  }
});

searchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    btnSearch.click();
  }
});

// Initialization
initMap();
connectSocket();

// Toggle Collapsible Directions List
btnToggleDirections.addEventListener('click', () => {
  const isHidden = directionsListContainer.style.display === 'none';
  if (isHidden) {
    directionsListContainer.style.display = 'block';
    btnToggleDirections.innerHTML = '<i class="fa-solid fa-eye-slash"></i> Hide Turn-by-Turn';
  } else {
    directionsListContainer.style.display = 'none';
    btnToggleDirections.innerHTML = '<i class="fa-solid fa-list-ol"></i> Show Turn-by-Turn';
  }
});

// Toggle Routing Functionality
btnToggleRouting.addEventListener('click', () => {
  if (isRoutingActive) {
    stopRouting();
  } else {
    startRouting();
  }
});

function stopRouting() {
  if (viewerWatchId !== null) {
    navigator.geolocation.clearWatch(viewerWatchId);
    viewerWatchId = null;
  }
  if (routingControl) {
    map.removeControl(routingControl);
    routingControl = null;
  }
  if (viewerMarker) {
    map.removeLayer(viewerMarker);
    viewerMarker = null;
  }
  
  isRoutingActive = false;
  routingDetails.style.display = 'none';
  btnToggleRouting.innerHTML = '<i class="fa-solid fa-route" style="color: var(--color-primary);"></i> Get Directions to Host';
  btnToggleRouting.className = 'btn btn-outline';
  
  // Hide details drawer
  directionsListContainer.style.display = 'none';
  btnToggleDirections.innerHTML = '<i class="fa-solid fa-list-ol"></i> Show Turn-by-Turn';
  directionsList.innerHTML = '<li>Calculating route...</li>';
  
  showToast('Directions deactivated.', 'info');
}

function startRouting() {
  if (!trackerLocation) {
    showToast('Waiting for host tracker coordinates to start route calculation...', 'warning');
    return;
  }

  if (!navigator.geolocation) {
    showToast('Your browser does not support geolocation start routing.', 'error');
    return;
  }

  btnToggleRouting.disabled = true;
  btnToggleRouting.textContent = 'Acquiring your location...';

  viewerWatchId = navigator.geolocation.watchPosition(
    (position) => {
      if (btnToggleRouting.disabled) {
        btnToggleRouting.disabled = false;
      }
      
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;
      viewerLocation = [lat, lon];

      isRoutingActive = true;
      routingDetails.style.display = 'flex';
      btnToggleRouting.innerHTML = '<i class="fa-solid fa-circle-stop" style="color: var(--color-error);"></i> Stop Directions';
      btnToggleRouting.className = 'btn btn-secondary';

      // Draw custom start marker (Green Pulse)
      if (!viewerMarker) {
        const startIcon = L.divIcon({
          className: 'pulse-marker-start',
          html: '<div class="pulse-ring-start"></div><div class="pulse-core-start"><i class="fa-solid fa-house" style="font-size: 8px; color: white;"></i></div>',
          iconSize: [30, 30],
          iconAnchor: [15, 15]
        });
        viewerMarker = L.marker(viewerLocation, { icon: startIcon }).addTo(map).bindPopup('Your Current Location');
      } else {
        viewerMarker.setLatLng(viewerLocation);
      }

      // Setup Routing Control
      if (!routingControl) {
        routingControl = L.Routing.control({
          waypoints: [
            L.latLng(lat, lon),
            L.latLng(trackerLocation[0], trackerLocation[1])
          ],
          lineOptions: {
            styles: [{ color: '#3B82F6', opacity: 0.8, weight: 6 }] // Electric Blue path
          },
          addWaypoints: false,
          draggableWaypoints: false,
          routeWhileDragging: false,
          fitSelectedRoutes: false,
          createMarker: function() { return null; } // Hide default L.Routing markers
        }).addTo(map);

        routingControl.on('routesfound', (e) => {
          const routes = e.routes;
          if (routes && routes.length > 0) {
            const summary = routes[0].summary;
            const distKm = (summary.totalDistance / 1000).toFixed(1);
            const timeMin = Math.round(summary.totalTime / 60);

            valRoutingDistance.textContent = `${distKm} km`;
            valRoutingTime.textContent = timeMin >= 60 
              ? `${Math.floor(timeMin/60)} hr ${timeMin%60} min` 
              : `${timeMin} min`;

            // Populate directions list
            directionsList.innerHTML = '';
            const steps = routes[0].instructions;
            steps.forEach((step) => {
              const li = document.createElement('li');
              const distLabel = step.distance >= 1000 
                ? `${(step.distance / 1000).toFixed(1)} km` 
                : `${Math.round(step.distance)} m`;
              li.innerHTML = `<strong>${step.text}</strong> <span style="color: var(--text-muted); font-size: 0.7rem;">(${distLabel})</span>`;
              directionsList.appendChild(li);
            });
          }
        });

        routingControl.on('routingerror', (e) => {
          console.error('Routing Error:', e);
          valRoutingDistance.textContent = 'N/A';
          valRoutingTime.textContent = 'N/A';
          directionsList.innerHTML = '<li style="color: var(--color-error);">No land route available between you and the host.</li>';
          showToast('No land route available to host location.', 'error');
        });

        showToast('Directions route loaded successfully.', 'success');
      } else {
        // Dynamically update coordinates when you or the host moves
        routingControl.setWaypoints([
          L.latLng(lat, lon),
          L.latLng(trackerLocation[0], trackerLocation[1])
        ]);
      }
    },
    (error) => {
      btnToggleRouting.disabled = false;
      btnToggleRouting.innerHTML = '<i class="fa-solid fa-route" style="color: var(--color-primary);"></i> Get Directions to Host';
      showToast('Could not acquire your location. Please grant permission.', 'error');
      console.error(error);
      stopRouting();
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}
