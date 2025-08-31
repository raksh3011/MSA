from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_socketio import SocketIO
from flask_login import LoginManager
from flask_jwt_extended import JWTManager
from flask_restx import Api
from flask_wtf.csrf import CSRFProtect
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from celery import Celery
from app.config import Config
from app.extensions import db, migrate, socketio, login_manager, jwt, api, csrf, limiter, celery
from app.mcp import MCP
from app.blueprints.dashboard import dashboard_bp
from app.blueprints.radar import radar_bp
from app.blueprints.auth import auth_bp
from app.blueprints.api import api_bp

def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)

    # Initialize extensions
    db.init_app(app)
    migrate.init_app(app, db)
    socketio.init_app(app)
    login_manager.init_app(app)
    jwt.init_app(app)
    api.init_app(app)
    csrf.init_app(app)
    limiter.init_app(app)
    app.celery = make_celery(app)

    # Register blueprints
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(radar_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(api_bp, url_prefix='/api')

    # MCP initialization
    app.mcp = MCP(app.config['ANTHROPIC_API_KEY'])

    return app

def make_celery(app):
    celery = Celery(
        app.import_name,
        backend=app.config['CELERY_RESULT_BACKEND'],
        broker=app.config['CELERY_BROKER_URL']
    )
    celery.conf.update(app.config)

    class ContextTask(celery.Task):
        def __call__(self, *args, **kwargs):
            with app.app_context():
                return self.run(*args, **kwargs)

    celery.Task = ContextTask
    return celery