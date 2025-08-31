from flask_socketio import emit
from app.extensions import socketio
from app.utils import update_ais_data, generate_alerts
from app.models import Vessel

@socketio.on('connect', namespace='/dashboard')
def connect():
    emit('connected', {'data': 'Connected'})

@socketio.on('update_data', namespace='/dashboard')
def update_data():
    df = pd.DataFrame([v.to_dict() for v in Vessel.query.all()])  # Simplified
    updated_df = update_ais_data(df)
    alerts = [generate_alerts(row, trajectories, maritime_boundary) for _, row in updated_df.iterrows()]
    emit('data_update', {'vessels': updated_df.to_dict(orient='records'), 'alerts': alerts})