from flask_socketio import emit
from app.extensions import socketio

@socketio.on('connect', namespace='/radar')
def connect():
    emit('connected', {'data': 'Connected'})

@socketio.on('update_radar', namespace='/radar')
def update_radar():
    # Fetch vessel data, emit for radar blips
    emit('radar_update', {'blips': []})  # Placeholder