const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Proxy endpoint for Ghana Post GPS Geocoding
app.post('/api/geocode-ghana', async (req, res) => {
  const { address } = req.body;
  if (!address) {
    return res.status(400).json({ error: 'Address parameter is required.' });
  }

  try {
    const response = await fetch('https://ghanapostgps.sperixlabs.org/get-location', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ address })
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'GhanaPost API responded with an error.' });
    }

    const data = await response.json();
    return res.json(data);
  } catch (error) {
    console.error('[Geocoding Proxy Error]:', error);
    return res.status(500).json({ error: 'Failed to geocode digital address.' });
  }
});

// Fallback routing for user friendly URLs, e.g. /track/:channel or /view/:channel
app.get('/track/:channelId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tracker.html'));
});

app.get('/view/:channelId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// Active location sessions stored in memory
// Map key: channelId (string)
// Value: {
//   trackers: Set<WebSocket>,
//   viewers: Set<WebSocket>,
//   history: Array<{ latitude, longitude, timestamp, accuracy }>,
//   cleanupTimeout: NodeJS.Timeout | null
// }
const sessions = new Map();

// Helper to get or create a session
function getOrCreateSession(channelId) {
  if (!sessions.has(channelId)) {
    sessions.set(channelId, {
      trackers: new Set(),
      viewers: new Set(),
      history: [],
      cleanupTimeout: null
    });
  }
  const session = sessions.get(channelId);
  if (session.cleanupTimeout) {
    clearTimeout(session.cleanupTimeout);
    session.cleanupTimeout = null;
  }
  return session;
}

// Clean up empty sessions after a grace period (e.g. 5 minutes)
function scheduleSessionCleanup(channelId) {
  const session = sessions.get(channelId);
  if (!session) return;

  if (session.trackers.size === 0 && session.viewers.size === 0) {
    if (session.cleanupTimeout) clearTimeout(session.cleanupTimeout);
    
    session.cleanupTimeout = setTimeout(() => {
      sessions.delete(channelId);
      console.log(`[Session Cleanup] Removed empty channel: ${channelId}`);
    }, 5 * 60 * 1000); // 5 minutes grace period
  }
}

wss.on('connection', (ws) => {
  let clientRole = null;
  let clientChannelId = null;

  console.log('[WS] Client connected');

  ws.on('message', (messageText) => {
    try {
      const data = JSON.parse(messageText);

      switch (data.type) {
        case 'register': {
          const { role, channelId } = data;
          if (!channelId || (role !== 'tracker' && role !== 'viewer')) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid registration parameters.' }));
            return;
          }

          clientRole = role;
          clientChannelId = channelId;

          const session = getOrCreateSession(channelId);

          if (role === 'tracker') {
            session.trackers.add(ws);
            console.log(`[WS] Tracker registered on channel: ${channelId}`);
            ws.send(JSON.stringify({ type: 'registered', role, channelId }));
            
            // Broadcast tracker status update to viewers
            broadcastToSession(channelId, { type: 'tracker_status', online: true });
          } else {
            session.viewers.add(ws);
            console.log(`[WS] Viewer registered on channel: ${channelId}`);
            
            // Send registration confirmation
            ws.send(JSON.stringify({ type: 'registered', role, channelId }));
            
            // Send existing coordinate history to the newly connected viewer
            if (session.history.length > 0) {
              ws.send(JSON.stringify({
                type: 'history',
                history: session.history
              }));
            }
            
            // Notify viewer whether a tracker is currently active
            ws.send(JSON.stringify({
              type: 'tracker_status',
              online: session.trackers.size > 0
            }));
          }
          break;
        }

        case 'telemetry': {
          if (clientRole !== 'tracker' || !clientChannelId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized telemetry transmission.' }));
            return;
          }

          const { latitude, longitude, timestamp, accuracy, speed } = data;
          if (typeof latitude !== 'number' || typeof longitude !== 'number') {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid coordinate values.' }));
            return;
          }

          const session = sessions.get(clientChannelId);
          if (!session) return;

          const coordinate = { latitude, longitude, timestamp: timestamp || Date.now(), accuracy, speed };
          
          // Store in history (cap at last 100 points)
          session.history.push(coordinate);
          if (session.history.length > 100) {
            session.history.shift();
          }

          // Broadcast coordinate telemetry to all viewers of this channel
          broadcastToSession(clientChannelId, {
            type: 'telemetry',
            ...coordinate
          });
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }

        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown action type.' }));
      }
    } catch (err) {
      console.error('[WS Error] Failed to parse message:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid payload format.' }));
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected. Role: ${clientRole}, Channel: ${clientChannelId}`);
    
    if (clientChannelId && sessions.has(clientChannelId)) {
      const session = sessions.get(clientChannelId);
      
      if (clientRole === 'tracker') {
        session.trackers.delete(ws);
        broadcastToSession(clientChannelId, { type: 'tracker_status', online: false });
      } else if (clientRole === 'viewer') {
        session.viewers.delete(ws);
      }
      
      scheduleSessionCleanup(clientChannelId);
    }
  });
});

// Broadcast helper
function broadcastToSession(channelId, messagePayload) {
  const session = sessions.get(channelId);
  if (!session) return;

  const payloadString = JSON.stringify(messagePayload);
  session.viewers.forEach((viewerSocket) => {
    if (viewerSocket.readyState === WebSocket.OPEN) {
      viewerSocket.send(payloadString);
    }
  });
}

// Start Server
server.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`GeoLocate Tracker running on http://localhost:${PORT}`);
  console.log(`WebSocket server active on port ${PORT}`);
  console.log(`==================================================`);
});
