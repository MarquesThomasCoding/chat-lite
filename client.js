let currentChannelId = null;
let currentChannelName = "Général";
const socket = io({
  ackTimeout: 10000,
  retries: 3,
});
const channelsList = document.getElementById("channels-list");
const createChannelForm = document.getElementById("create-channel-form");
const createChannelInput = document.getElementById("create-channel-input");
const currentChannelDiv = document.getElementById("current-channel");
const messages = document.getElementById("messages");
const form = document.getElementById("form");
const input = document.getElementById("input");

function displayChannels(channels) {
  channelsList.innerHTML = "";
  channels.forEach((channel) => {
    const li = document.createElement("li");
    li.textContent = `#${channel.name}`;
    li.className = channel.id === currentChannelId ? "active" : "";
    li.addEventListener("click", () => {
      if (channel.id !== currentChannelId) {
        joinChannel(channel.id, channel.name);
      }
    });
    channelsList.appendChild(li);
  });
}

function joinChannel(channelId, channelName) {
  currentChannelId = channelId;
  currentChannelName = channelName;
  currentChannelDiv.textContent = `#${channelName}`;
  messages.innerHTML = "";

  Array.from(channelsList.children).forEach((li) => {
    li.classList.toggle("active", li.textContent === `#${channelName}`);
  });
  socket.emit("join channel", channelId, (res) => {
    if (res && res.success) {
    }
  });
}

createChannelForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = createChannelInput.value.trim();
  if (name) {
    socket.emit("create channel", name, (res) => {
      if (res && res.success) {
        createChannelInput.value = "";
      } else if (res && res.error) {
        alert(res.error);
      }
    });
  }
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (input.value && currentChannelId) {
    socket.emit("channel message", input.value, () => {
      input.value = "";
    });
  }
});

socket.on("channel messages", (msgs) => {
  messages.innerHTML = "";
  msgs.forEach((msg) => {
    const item = document.createElement("li");
    item.innerHTML = `
        <div style="font-size: 0.8rem; font-weight: bold; color: gray;">
            ${msg.sender_id === socket.id ? "Moi" : msg.sender_id}
        </div>
        <div>${msg.content}</div>
    `;
    messages.appendChild(item);
  });
  messages.scrollTop = messages.scrollHeight;
});

socket.on("channel message", (msg) => {
  const item = document.createElement("li");
  item.innerHTML = `
        <div style="font-size: 0.8rem; font-weight: bold; color: gray;">
            ${msg.sender_id === socket.id ? "Moi" : msg.sender_id}
        </div>
        <div>${msg.content}</div>
    `;
  messages.appendChild(item);
  messages.scrollTop = messages.scrollHeight;
});

socket.on("channel list", (channels) => {
  displayChannels(channels);
});

socket.on("joined channel", (channel) => {
  currentChannelId = channel.id;
  currentChannelName = channel.name;
  currentChannelDiv.textContent = `#${channel.name}`;
});
