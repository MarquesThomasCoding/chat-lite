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
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork({
        PORT: 3000 + i
        });
    }
    setupPrimary();
} else {
    const db = await open({
        filename: 'chat.db',
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE
        );
    `);
    
    await db.exec(`
        CREATE TABLE IF NOT EXISTS channel_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER,
            sender_id TEXT,
            content TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(channel_id) REFERENCES channels(id)
        );
    `);

    const __dirname = dirname(fileURLToPath(import.meta.url));

    const app = express();
    app.use(express.static(__dirname));

    const server = createServer(app);
    const io = new Server(server, {
        connectionStateRecovery: {},
        adapter: createAdapter()
    });


    app.get('/', (req, res) => {
        res.sendFile(join(__dirname, 'index.html'));
    });

    // API pour récupérer la liste des channels
    app.get('/channels', async (req, res) => {
        const channels = await db.all('SELECT id, name FROM channels');
        res.json(channels);
    });

    io.on('connection', async (socket) => {
        console.log('Utilisateur connecté:', socket.id);
        
        let defaultChannel = await db.get('SELECT id FROM channels WHERE name = ?', 'Général');
        if (!defaultChannel) {
            await db.run('INSERT INTO channels (name) VALUES (?)', 'Général');
            defaultChannel = await db.get('SELECT id FROM channels WHERE name = ?', 'Général');
        }
        socket.join(`channel_${defaultChannel.id}`);
        socket.data.currentChannel = defaultChannel.id;

        
        const channels = await db.all('SELECT id, name FROM channels');
        socket.emit('channel list', channels);
        socket.emit('joined channel', { id: defaultChannel.id, name: 'Général' });

        const messages = await db.all('SELECT sender_id, content, created_at FROM channel_messages WHERE channel_id = ? ORDER BY id ASC', defaultChannel.id);
        socket.emit('channel messages', messages);

        socket.on('create channel', async (channelName, callback) => {
            try {
                await db.run('INSERT INTO channels (name) VALUES (?)', channelName);
                const channels = await db.all('SELECT id, name FROM channels');
                io.emit('channel list', channels);
                if(callback) callback({ success: true });
            } catch (e) {
                if(callback) callback({ success: false, error: 'Nom de channel déjà utilisé.' });
            }
        });

        socket.on('join channel', async (channelId, callback) => {
            if (socket.data.currentChannel) {
                socket.leave(`channel_${socket.data.currentChannel}`);
            }
            socket.join(`channel_${channelId}`);
            socket.data.currentChannel = channelId;

            const messages = await db.all('SELECT sender_id, content, created_at FROM channel_messages WHERE channel_id = ? ORDER BY id ASC', channelId);
            socket.emit('channel messages', messages);

            const channel = await db.get('SELECT id, name FROM channels WHERE id = ?', channelId);
            socket.emit('joined channel', channel);
            if(callback) callback({ success: true });
        });

        socket.on('channel message', async (msg, callback) => {
            const channelId = socket.data.currentChannel;
            if (!channelId) return;
            await db.run('INSERT INTO channel_messages (channel_id, sender_id, content) VALUES (?, ?, ?)', channelId, socket.id, msg);
            const message = { sender_id: socket.id, content: msg, created_at: new Date().toISOString() };
            io.to(`channel_${channelId}`).emit('channel message', message);
            callback && callback();
        });

        socket.on('disconnect', () => {
            console.log('Utilisateur déconnecté:', socket.id);
        });
    });

    const port = process.env.PORT;
    server.listen(port, () => {
        console.log(`server running at http://localhost:${port}`);
    });
}