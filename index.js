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

if(cluster.isPrimary) {
    const numCPUs = availableParallelism();
    // create one worker per available core
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork({
        PORT: 3000 + i
        });
    }
  
  // set up the adapter on the primary thread
  setupPrimary();
} else {
    // open the database file
    const db = await open({
        filename: 'chat.db',
        driver: sqlite3.Database
    });

    // create our 'messages' table (ajout de la colonne room)
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
        adapter: createAdapter()
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

        // Gestion des rooms côté serveur
        socket.on('join room', async (newRoom, oldRoom, callback) => {
            if (oldRoom) {
                await socket.leave(oldRoom);
            }
            await socket.join(newRoom);
            // Récupérer l'historique de la room
            const history = await db.all('SELECT content as msg, id as serverOffset FROM messages WHERE room = ? ORDER BY id ASC LIMIT 50', newRoom);
            socket.emit('room history', history, newRoom);
            if (typeof callback === 'function') callback();
        });

        socket.on('chat message', async (msg, clientOffset, room, callback) => {
            let result;
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
            
            // Utiliser process.nextTick pour s'assurer que la socket est complètement supprimée
            process.nextTick(async () => {
                // Utiliser l'adapter pour obtenir tous les sockets de tous les workers
                const sockets = await io.fetchSockets();
                const connectedUsers = sockets.map(s => s.id);
                console.log('Utilisateurs connectés après déconnexion:', connectedUsers);
                io.emit('connected users', connectedUsers);
                
                // Notifier les autres utilisateurs qu'un utilisateur s'est déconnecté
                socket.broadcast.emit('user disconnected', socket.id);
            });
        });

        if (!socket.recovered) {
            // if the connection state recovery was not successful
            try {
                // Par défaut, on envoie l'historique de la room "Général"
                const defaultRoom = 'Général';
                const history = await db.all('SELECT content as msg, id as serverOffset FROM messages WHERE room = ? ORDER BY id ASC LIMIT 50', defaultRoom);
                socket.emit('room history', history, defaultRoom);
            } catch (e) {
                // something went wrong
            }
        }
    });

    const port = process.env.PORT;

    server.listen(port, () => {
        console.log(`server running at http://localhost:${port}`);
    });
}