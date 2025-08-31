from app import create_app, extensions
from app.extensions import celery

app = create_app()
app.app_context().push()