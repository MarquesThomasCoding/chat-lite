import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { availableParallelism } from 'node:os';
import cluster from 'node:cluster';
import { createAdapter, setupPrimary } from '@socket.io/cluster-adapter';
import { PeerServer } from 'peer';

// if (cluster.isPrimary) {
//   const numCPUs = availableParallelism();
//   for (let i = 0; i < 6; i++) {
//     cluster.fork({ PORT: 3000 + i });
//   }
//   setupPrimary();
// } else {
  const db = await open({
    filename: 'chat.db',
    driver: sqlite3.Database
  });

  const peerIds = {};

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      content TEXT,
      room TEXT
    );
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    // adapter: createAdapter()
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));
  app.use(express.static(__dirname));
  const tttGames = new Map(); // Pour gérer les parties de TTT

  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });

  async function updateGamePlayers() {
    const game = tttGames.get(TTT_ROOM);
    if (!game) return;

    const sockets = await io.in(TTT_ROOM).fetchSockets();
    game.players.clear();

    // Attribuer 'X' et 'O' aux deux premiers sockets
    if (sockets.length >= 1) {
      game.players.set(sockets[0].id, 'X');
    }
    if (sockets.length >= 2) {
      game.players.set(sockets[1].id, 'O');
    }
    for (let i = 2; i < sockets.length; i++) {
      game.players.set(sockets[i].id, null);
    }

    // Si le jeu est réinitialisé ou si c'est une nouvelle partie, currentPlayer devrait être 'X'
    if (!game.winner && game.board.every(cell => cell === null)) {
      game.currentPlayer = 'X';
    }

    // Mettre à jour tous les joueurs
    for (const s of sockets) {
      const symbol = game.players.get(s.id);
      s.emit('ttt update', {
        board: game.board,
        currentPlayer: game.currentPlayer,
        winner: game.winner,
        symbol
      });
    }
  }

  const TTT_ROOM = 'ttt';
  tttGames.set(TTT_ROOM, {
    board: Array(9).fill(null),
    currentPlayer: 'X',
    players: new Map(),
    winner: null
  });

  io.on('connection', async (socket) => {
    console.log('Utilisateur connecté:', socket.id);

    process.nextTick(async () => {
      const sockets = await io.fetchSockets();
      const connectedUsers = sockets.map(s => s.id);
      io.emit('connected users', connectedUsers);
      socket.broadcast.emit('user connected', socket.id);
    });

    socket.on('peer-id', (peerId) => {
        // Vérifie que le socket est bien dans la room "Vidéo"
        if (!socket.rooms.has('Vidéo')) {
            console.log('Refus peer-id : pas dans la room Vidéo');
            return;
        }
        peerIds[socket.id] = peerId;
        // Envoie la liste des peerIds déjà présents dans la room Vidéo
        io.in('Vidéo').fetchSockets().then(socketsInRoom => {
            const idsInRoom = socketsInRoom.map(s => s.id);
            const otherPeers = Object.entries(peerIds)
                .filter(([id]) => id !== socket.id && idsInRoom.includes(id))
                .map(([id, pid]) => ({ userId: id, peerId: pid }));
            socket.emit('all-peers', otherPeers);
            // Informe les autres membres de la room Vidéo
            socket.to('Vidéo').emit('user-connected', { userId: socket.id, peerId });
            console.log('Broadcast user-connected (Vidéo)', { userId: socket.id, peerId });
        });
    });

    // === CHAT ROOMS ===
    socket.on('join room', async (newRoom, oldRoom, callback) => {
      if (oldRoom) await socket.leave(oldRoom);
      await socket.join(newRoom);
      const history = await db.all(
        'SELECT content as msg, id as serverOffset FROM messages WHERE room = ? ORDER BY id ASC LIMIT 50',
        newRoom
      );
      socket.emit('room history', history, newRoom);
      if (typeof callback === 'function') callback();
    });

    socket.on('chat message', async (msg, clientOffset, room, callback) => {
      let result;
      try {
        result = await db.run(
          'INSERT INTO messages (content, client_offset, room) VALUES (?, ?, ?)',
          msg, clientOffset, room
        );
      } catch (e) {
        if (e.errno === 19 && typeof callback === 'function') callback();
        return;
      }
      io.to(room).emit('chat message', msg, result.lastID, room);
      if (typeof callback === 'function') callback();
    });

    socket.on('disconnect', async () => {
      console.log('Utilisateur déconnecté:', socket.id);
      const game = tttGames.get(TTT_ROOM);
      if (game) {
        await updateGamePlayers();
      }
      // Mettre à jour la liste des utilisateurs connectés
      const sockets = await io.fetchSockets();
      const connectedUsers = sockets.map(s => s.id);
      io.emit('connected users', connectedUsers);
      socket.broadcast.emit('user disconnected', socket.id);
    });

    if (!socket.recovered) {
      const defaultRoom = 'Général';
      const history = await db.all(
        'SELECT content as msg, id as serverOffset FROM messages WHERE room = ? ORDER BY id ASC LIMIT 50',
        defaultRoom
      );
      socket.emit('room history', history, defaultRoom);
    }

    // === TTT GAME ===
    socket.on('ttt join', async () => {
      await socket.join(TTT_ROOM);
      await updateGamePlayers();
    });

    socket.on('ttt move', async (index) => {
      const game = tttGames.get(TTT_ROOM);
      const symbol = game.players.get(socket.id);
      console.log(`Move attempt by ${socket.id}: symbol=${symbol}, currentPlayer=${game.currentPlayer}, index=${index}`);

      if (game.winner) {
        console.log('Game already has a winner:', game.winner);
        return;
      }
      if (game.board[index] !== null) {
        console.log('Cell is already occupied');
        return;
      }
      if (symbol !== game.currentPlayer) {
        console.log(`Not your turn. Your symbol: ${symbol}, current player: ${game.currentPlayer}`);
        return;
      }

      console.log(`Placing symbol: ${symbol} at index ${index}`);
      game.board[index] = symbol;

      // Vérification des combinaisons gagnantes
      const winCombos = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
      ];
      for (const [a, b, c] of winCombos) {
        if (game.board[a] && game.board[a] === game.board[b] && game.board[a] === game.board[c]) {
          game.winner = symbol;
          break;
        }
      }
      if (!game.winner && game.board.every(cell => cell !== null)) {
        game.winner = 'draw';
      }
      game.currentPlayer = game.currentPlayer === 'X' ? 'O' : 'X';
      console.log(`Next player: ${game.currentPlayer}`);

      await updateGamePlayers();
    });

    socket.on('ttt reset', async () => {
      const game = tttGames.get(TTT_ROOM);
      game.board = Array(9).fill(null);
      game.currentPlayer = 'X';
      game.winner = null;
      await updateGamePlayers();
    });
  });

  const port = 3000;
  server.listen(port, () => {
    console.log(`Serveur en ligne : http://localhost:${port}`);
  });
  const peerServer = PeerServer({ port: 3001, path: '/' });
// }
