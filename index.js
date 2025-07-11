import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { PeerServer } from 'peer';

// MODE SANS CLUSTER
// On retire tout le code lié à cluster et on lance un seul serveur

// open the database file
const dbPromise = open({
    filename: 'chat.db',
    driver: sqlite3.Database
});

const peerIds = {}; // socket.id => peerId

const app = express();
const server = createServer(app);
const io = new Server(server, {
    connectionStateRecovery: {}
});

const __dirname = dirname(fileURLToPath(import.meta.url));

// Servir les fichiers statiques avec les bons types MIME
app.use(express.static(process.cwd(), {
  setHeaders: (res, path) => {
    if (path.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
}));

app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
});

io.on('connection', async (socket) => {
    console.log('Un utilisateur s\'est connecté:', socket.id);

    // Utiliser process.nextTick pour s'assurer que la socket est complètement ajoutée
    process.nextTick(async () => {
        // Utiliser l'adapter pour obtenir tous les sockets de tous les workers
        const sockets = await io.fetchSockets();
        const connectedUsers = sockets.map(s => s.id);
        console.log('Utilisateurs connectés:', connectedUsers);
        io.emit('connected users', connectedUsers);
        // Notifier les autres utilisateurs qu'un nouvel utilisateur s'est connecté
        socket.broadcast.emit('user connected', socket.id);
    });

    // Gestion des peerIds pour la vidéo
    socket.on('peer-id', (peerId) => {
        peerIds[socket.id] = peerId;
        // Envoie la liste des peerIds déjà présents au nouvel arrivant
        const otherPeers = Object.entries(peerIds)
            .filter(([id]) => id !== socket.id)
            .map(([id, pid]) => ({ userId: id, peerId: pid }));
        socket.emit('all-peers', otherPeers);
        // Log pour vérifier l'émission de l'événement
        console.log('Broadcast user-connected', { userId: socket.id, peerId });
        // Informe les autres qu'un nouvel utilisateur est arrivé
        socket.broadcast.emit('user-connected', { userId: socket.id, peerId });
    });

    // Gestion des rooms côté serveur
    socket.on('join room', async (newRoom, oldRoom, callback) => {
        if (oldRoom) {
            await socket.leave(oldRoom);
        }
        await socket.join(newRoom);
        // Récupérer l'historique de la room
        const db = await dbPromise;
        const history = await db.all('SELECT content as msg, id as serverOffset FROM messages WHERE room = ? ORDER BY id ASC LIMIT 50', newRoom);
        socket.emit('room history', history, newRoom);
        if (typeof callback === 'function') callback();
    });

    socket.on('chat message', async (msg, clientOffset, room, callback) => {
        let result;
        const db = await dbPromise;
        try {
            // store the message in the database avec la room
            result = await db.run('INSERT INTO messages (content, client_offset, room) VALUES (?, ?, ?)', msg, clientOffset, room);
        } catch (e) {
            if(e.errno === 19) {
                if (typeof callback === 'function') callback();
            } else {
            }
            return;
        }
        // include the offset with the message
        io.to(room).emit('chat message', msg, result.lastID, room);
        if (typeof callback === 'function') callback();
    });

    socket.on('disconnect', () => {
        console.log('Un utilisateur s\'est déconnecté:', socket.id);
        // Suppression du peerId
        delete peerIds[socket.id];
        socket.broadcast.emit('user-disconnected', socket.id);
        // Utiliser process.nextTick pour s'assurer que la socket est complètement supprimée
        process.nextTick(async () => {
            const sockets = await io.fetchSockets();
            const connectedUsers = sockets.map(s => s.id);
            console.log('Utilisateurs connectés après déconnexion:', connectedUsers);
            io.emit('connected users', connectedUsers);
            socket.broadcast.emit('user disconnected', socket.id);
        });
    });

    if (!socket.recovered) {
        // if the connection state recovery was not successful
        try {
            // Par défaut, on envoie l'historique de la room "Général"
            const db = await dbPromise;
            const defaultRoom = 'Général';
            const history = await db.all('SELECT content as msg, id as serverOffset FROM messages WHERE room = ? ORDER BY id ASC LIMIT 50', defaultRoom);
            socket.emit('room history', history, defaultRoom);
        } catch (e) {
            // something went wrong
        }
    }
});

const port = 3000;

server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
});

const peerServer = PeerServer({ port: 3001, path: '/peerjs' });