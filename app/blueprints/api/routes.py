from flask_restx import Resource, fields
from app.blueprints.api import api_bp
from app.extensions import api
from app.models import Vessel

ns = api.namespace('vessels', description='Vessel operations')

vessel_model = api.model('Vessel', {
    'vessel_id': fields.String(required=True),
    'lat': fields.Float,
    'lon': fields.Float,
    'speed': fields.Float,
    'heading': fields.Float,
    'timestamp': fields.Float,
    'trajectory': fields.String,
    'is_friendly': fields.Integer
})

@ns.route('/')
class VesselList(Resource):
    @ns.marshal_list_with(vessel_model)
    def get(self):
        return Vessel.query.all()

@ns.route('/<id>')
class VesselResource(Resource):
    @ns.marshal_with(vessel_model)
    def get(self, id):
        return Vessel.query.get(id)