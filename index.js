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

    // create our 'messages' table (you can ignore the 'client_offset' column for now)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_offset TEXT UNIQUE,
            content TEXT
        );
    `);

    const app = express();
    const server = createServer(app);
    const io = new Server(server, {
        connectionStateRecovery: {},
        adapter: createAdapter()
    });

    const __dirname = dirname(fileURLToPath(import.meta.url));

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

        socket.on('chat message', async (msg, clientOffset, callback) => {
            let result;
            try {
            // store the message in the database
            result = await db.run('INSERT INTO messages (content, client_offset) VALUES (?, ?)', msg, clientOffset);
            } catch (e) {
                if(e.errno === 19) {
                    callback()
                } else {
                }
            return;
            }
            // include the offset with the message
            io.emit('chat message', msg, result.lastID);
            callback();
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
            await db.each('SELECT id, content FROM messages WHERE id > ?',
                [socket.handshake.auth.serverOffset || 0],
                (_err, row) => {
                socket.emit('chat message', row.content, row.id);
                }
            )
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