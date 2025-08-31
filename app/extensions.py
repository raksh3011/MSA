from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_socketio import SocketIO
from flask_login import LoginManager
from flask_jwt_extended import JWTManager
from flask_restx import Api
from flask_wtf.csrf import CSRFProtect
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

db = SQLAlchemy()
migrate = Migrate()
socketio = SocketIO()
login_manager = LoginManager()
jwt = JWTManager()
api = Api(version='1.0', title='Maritime API', description='API for maritime surveillance')
csrf = CSRFProtect()
limiter = Limiter(key_func=get_remote_address)

celery = None  # Initialized in __init__.py