from app.mcp import MCP
from app.utils import query_rag
from langgraph import Agent

class AnalysisAgent(Agent):
    def __init__(self, mcp):
        self.mcp = mcp

    def run(self, input_data):
        # RAG query
        query = input_data.get('query', "Historical incidents for this vessel")
        rag_response = query_rag(query)

        # LLM analysis
        prompt = f"Analyze anomalies with context: {input_data['anomalies'].to_json()} and RAG: {rag_response}"
        response = self.mcp.send_message_with_context('analysis', prompt, model="claude-3-opus-20240229")

        return {"analysis": response}