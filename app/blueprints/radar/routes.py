from flask import render_template
from app.blueprints.radar import radar_bp

@radar_bp.route('/radar')
def radar():
    return render_template('radar.html')