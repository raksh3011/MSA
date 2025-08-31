// SocketIO client setup
const socket = io('/dashboard');  // Adjust for namespace

socket.on('connect', () => {
    console.log('Connected to SocketIO');
});

// Audio playback
function playBeep() {
    var audio = new Audio('/static/audio/emergency-intercom.mp3');
    audio.play();
}

// Example map update
socket.on('data_update', (data) => {
    // Update Leaflet markers
    // Play beep if new alerts
    if (data.alerts.length > 0) {
        playBeep();
    }
});

// AJAX for add vessel
document.getElementById('add-vessel-form').addEventListener('submit', (e) => {
    e.preventDefault();
    fetch('/add_vessel', {
        method: 'POST',
        body: JSON.stringify(/* form data */),
        headers: {'Content-Type': 'application/json'}
    }).then(response => response.json())
      .then(data => {
        // Update UI
    });
});