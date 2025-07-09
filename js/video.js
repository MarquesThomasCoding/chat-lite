const videoContainer = document.getElementById('video-container');
const myVideoStream = document.createElement('video');
const socket = io();
const peer = new Peer(undefined, {
    host: 'localhost',
    secure: true,
    port: 3000,
});

let peers = {};

myVideoStream.muted = true;

navigator.mediaDevices.getUserMedia({
    video: true,
    audio: true
}).then(stream => {
    addVideoStream(myVideoStream, stream);
    peer.on('call', call => {
        call.answer(stream);
        const video = document.createElement('video');
        call.on('stream', userVideoStream => {
            addVideoStream(video, userVideoStream);
        });
    });
});

peer.on('open', () => {
    console.log('Connected to peer server');
});

socket.on('user-connected', userId => {
    connectToNewUser(userId, stream);
});

socket.on('user-disconnected', userId => {
    if (peers[userId]) {
        peers[userId].close();
    }
});

const connectToNewUser = (userId, stream) => {
    const call = peer.call(userId, stream);
    const video = document.createElement('video');
    call.on('stream', userVideoStream => {
        addVideoStream(video, userVideoStream);
    });
    call.on("close", () => {
        video.remove();
    })

    peers[userId] = call;
};

const addVideoStream = (video, stream) => {
    video.srcObject = stream;
    video.addEventListener('loadedmetadata', () => {
        video.play();
    });
    videoContainer.append(video);
};