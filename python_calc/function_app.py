import azure.functions as func

# Reuse the existing FastAPI app
from app.main import app as fastapi_app

# Expose FastAPI via Azure Functions (ASGI)
app = func.AsgiFunctionApp(app=fastapi_app, http_auth_level=func.AuthLevel.ANONYMOUS)
