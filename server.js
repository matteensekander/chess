const { WebSocketServer } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, excludeWs = null) {
  for (const p of room.players) {
    if (p.ws !== excludeWs) send(p.ws, msg);
  }
  for (const s of room.spectators) {
    if (s.ws !== excludeWs) send(s.ws, msg);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('Gambit Chess Server');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let room = null;
  let role = null;  // 'player' | 'spectator'
  let color = null; // 'w' | 'b'
  let name = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'create-room': {
        const code = genCode();
        room = {
          code,
          players: [],
          spectators: [],
          started: false,
          gameState: null,
          chatHistory: [],
          createdAt: Date.now()
        };
        rooms.set(code, room);
        color = Math.random() < 0.5 ? 'w' : 'b';
        name = (msg.name || 'Player').slice(0, 24);
        role = 'player';
        room.players.push({ ws, color, name, connected: true });
        send(ws, { type: 'room-created', code, color, name });
        break;
      }

      case 'join-room': {
        const code = (msg.code || '').toUpperCase().trim();
        const target = rooms.get(code);
        if (!target) {
          send(ws, { type: 'error', message: 'Room not found. Check the code and try again.' });
          return;
        }

        const joinName = (msg.name || 'Player').slice(0, 24);

        // Reconnection: same name, slot disconnected
        const slot = target.players.find(p => !p.connected && p.name === joinName);
        if (slot) {
          slot.ws = ws;
          slot.connected = true;
          room = target;
          role = 'player';
          color = slot.color;
          name = slot.name;
          const opp = target.players.find(p => p !== slot);
          send(ws, {
            type: 'room-joined', code, color, name,
            opponentName: opp?.name || null,
            started: target.started,
            gameState: target.gameState,
            chatHistory: target.chatHistory
          });
          broadcast(target, { type: 'player-reconnected', color, name }, ws);
          return;
        }

        // Spectator if room full
        if (target.players.length >= 2) {
          room = target;
          role = 'spectator';
          name = joinName;
          target.spectators.push({ ws, name });
          send(ws, {
            type: 'spectating', code,
            gameState: target.gameState,
            chatHistory: target.chatHistory,
            players: target.players.map(p => ({ color: p.color, name: p.name }))
          });
          return;
        }

        // Second player
        const existingColor = target.players[0].color;
        color = existingColor === 'w' ? 'b' : 'w';
        name = joinName;
        role = 'player';
        target.players.push({ ws, color, name, connected: true });
        target.started = true;
        room = target;

        send(ws, {
          type: 'room-joined', code, color, name,
          opponentName: target.players[0].name,
          started: true, gameState: null, chatHistory: target.chatHistory
        });
        send(target.players[0].ws, {
          type: 'opponent-joined', opponentName: name, opponentColor: color
        });
        broadcast(target, {
          type: 'game-start',
          players: target.players.map(p => ({ color: p.color, name: p.name }))
        });
        break;
      }

      case 'move': {
        if (!room || role !== 'player') return;
        if (msg.gameState) room.gameState = msg.gameState;
        broadcast(room, {
          type: 'move',
          fr: msg.fr, fc: msg.fc, tr: msg.tr, tc: msg.tc,
          promo: msg.promo, san: msg.san,
          gameState: msg.gameState
        }, ws);
        break;
      }

      case 'chat': {
        if (!room) return;
        const text = (msg.text || '').slice(0, 300).trim();
        if (!text) return;
        const chatMsg = { type: 'chat', name, text, color };
        room.chatHistory.push(chatMsg);
        if (room.chatHistory.length > 300) room.chatHistory.shift();
        broadcast(room, chatMsg);
        break;
      }

      case 'game-over': {
        if (!room) return;
        if (msg.gameState) room.gameState = msg.gameState;
        broadcast(room, {
          type: 'game-over',
          title: msg.title, message: msg.message, result: msg.result
        }, ws);
        break;
      }

      case 'draw-offer': {
        if (!room || role !== 'player') return;
        broadcast(room, { type: 'draw-offer', from: color }, ws);
        break;
      }

      case 'draw-response': {
        if (!room || role !== 'player') return;
        broadcast(room, { type: 'draw-response', accepted: !!msg.accepted }, ws);
        break;
      }

      case 'resign': {
        if (!room || role !== 'player') return;
        broadcast(room, { type: 'resign', color }, ws);
        break;
      }

      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    if (role === 'spectator') {
      room.spectators = room.spectators.filter(s => s.ws !== ws);
      return;
    }
    const player = room.players.find(p => p.ws === ws);
    if (player) {
      player.connected = false;
      broadcast(room, { type: 'player-disconnected', color: player.color, name: player.name }, ws);
    }
    // Delete room 15 min after both players gone
    if (room.players.every(p => !p.connected)) {
      setTimeout(() => {
        if (room && room.players.every(p => !p.connected)) rooms.delete(room.code);
      }, 15 * 60 * 1000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Gambit chess server listening on port ${PORT}`);
});
