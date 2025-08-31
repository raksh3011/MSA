from app.extensions import db

class Vessel(db.Model):
    id = db.Column(db.String(50), primary_key=True)
    lat = db.Column(db.Float)
    lon = db.Column(db.Float)
    speed = db.Column(db.Float)
    heading = db.Column(db.Float)
    timestamp = db.Column(db.Float)
    trajectory = db.Column(db.Text)
    is_friendly = db.Column(db.Integer)

class Alert(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    vessel_id = db.Column(db.String(50))
    type = db.Column(db.String(50))
    message = db.Column(db.Text)
    timestamp = db.Column(db.Float)

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(50), unique=True)
    password = db.Column(db.String(255))
    role = db.Column(db.String(50))  # e.g., admin, operator

class AgentLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    agent_type = db.Column(db.String(50))
    action = db.Column(db.Text)
    timestamp = db.Column(db.Float)