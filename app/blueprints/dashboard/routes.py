from flask import render_template, request, jsonify
from app.blueprints.dashboard import dashboard_bp
from app.models import Vessel
from app.utils import predict_trajectory, save_vessel_to_db, remove_vessel_from_db, generate_alerts
from app.extensions import db
from app.agents.orchestrator import orchestrate_workflow
from app.mcp import MCP

mcp = MCP(Config.ANTHROPIC_API_KEY)

@dashboard_bp.route('/dashboard', methods=['GET', 'POST'])
def dashboard():
    vessels = Vessel.query.all()
    # Render original UI
    return render_template('dashboard.html', vessels=vessels)

@dashboard_bp.route('/add_vessel', methods=['POST'])
def add_vessel():
    data = request.json
    trajectory = predict_trajectory(data['lat'], data['lon'], data['speed'], data['heading'], data['time_minutes'])
    vessel = {
        'vessel_id': data['vessel_id'],
        'lat': data['lat'],
        'lon': data['lon'],
        'speed': data['speed'],
        'heading': data['heading'],
        'timestamp': datetime.now().timestamp()
    }
    save_vessel_to_db(vessel, trajectory, data['is_friendly'])
    # Trigger agentic workflow
    orchestrate_workflow(mcp, {'vessel_df': pd.DataFrame([vessel])})
    return jsonify({'success': True})

@dashboard_bp.route('/remove_vessel', methods=['POST'])
def remove_vessel():
    vessel_id = request.json['vessel_id']
    remove_vessel_from_db(vessel_id)
    return jsonify({'success': True})