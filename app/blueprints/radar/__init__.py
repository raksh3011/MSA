from flask import Blueprint

radar_bp = Blueprint('radar', __name__, template_folder='templates')

from .routes import *
from .sockets import *