from app.mcp import MCP
from langgraph import Agent

class ResponseAgent(Agent):
    def __init__(self, mcp):
        self.mcp = mcp

    def run(self, input_data):
        prompt = f"Generate response plan for analysis: {input_data['analysis']}"
        response = self.mcp.send_message_with_context('response', prompt)

        # Example action: Send alert via SocketIO
        from app.extensions import socketio
        socketio.emit('new_alert', {'message': response})

        return {"response_plan": response}