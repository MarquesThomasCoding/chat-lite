function startVideoRoom() {
    const videoContainer = document.getElementById('video-container');
    const myVideoStream = document.createElement('video');
    const videoSocket = io();
    const peer = new Peer( undefined, {
        host: 'chat-lite-qw2x.onrender.com/',
        port: 443,
        secure: true,
    });
    let peers = {};
    let localStream;
    myVideoStream.muted = true;

    navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
    }).then(stream => {
        localStream = stream;
        addVideoStream(myVideoStream, stream);
        peer.on('call', call => {
            call.answer(stream);
            const video = document.createElement('video');
            console.log('Received call from peer');
            call.on('stream', userVideoStream => {
                addVideoStream(video, userVideoStream);
            });
        });

        // On écoute l'événement user-connected ici, une fois qu'on a le stream
        peer.on('open', (id) => {
            // Rejoindre la room "Vidéo" avant d'envoyer le peer-id
            videoSocket.emit('join room', 'Vidéo', null, () => {
                if (videoSocket.connected) {
                    videoSocket.emit('peer-id', id);
                } else {
                    videoSocket.on('connect', () => {
                        videoSocket.emit('peer-id', id);
                    });
                }
                console.log('Connected to peer server with id:', id);
            });
        });

        // Quand on reçoit la liste des autres peerIds déjà présents
        videoSocket.on('all-peers', (peersList) => {
            peersList.forEach(({ peerId }) => {
                connectToNewUser(peerId, localStream);
            });
        });

        videoSocket.on('user-connected', ({ peerId }) => {
            console.log('user-connected');
            console.log(peerId);
            connectToNewUser(peerId, localStream);
        });
    });

    peer.on('open', () => {
        console.log('Connected to peer server');
    });

    videoSocket.on('user-disconnected', userId => {
        if (peers[userId]) {
            peers[userId].close();
        }
    });

    // On modifie connectToNewUser pour prendre peerId
    const connectToNewUser = (peerId, stream) => {
        const call = peer.call(peerId, stream);
        const video = document.createElement('video');
        call.on('stream', userVideoStream => {
            console.log('event');
            addVideoStream(video, userVideoStream);
        });
        call.on("close", () => {
            video.remove();
        })

        peers[peerId] = call;
    };

    const addVideoStream = (video, stream) => {
        console.log('Adding video stream');
        video.srcObject = stream;
        video.addEventListener('loadedmetadata', () => {
            video.play();
        });
        videoContainer.append(video);
    };
}

// Attacher le handler sur le bouton Video
window.addEventListener('DOMContentLoaded', () => {
    const videoBtn = document.querySelector('.room-btn[data-room="Video"]');
    if (videoBtn) {
        videoBtn.addEventListener('click', () => {
            startVideoRoom();
        }, { once: true }); // Empêche de lancer plusieurs fois
    }
});