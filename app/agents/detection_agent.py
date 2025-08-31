from app.mcp import MCP
from app.utils import perform_ocr, detect_anomalies
from langgraph import Agent

class DetectionAgent(Agent):
    def __init__(self, mcp):
        self.mcp = mcp

    def run(self, input_data):
        # Example: OCR on image, then anomaly detection
        if 'image_path' in input_data:
            text = perform_ocr(input_data['image_path'])
            input_data['ocr_text'] = text

        # Anomaly detection on vessel data
        df = input_data['vessel_df']
        anomalies = detect_anomalies(df)

        # LLM for threat detection
        prompt = f"Analyze this data for threats: {anomalies.to_json()}"
        response = self.mcp.send_message_with_context('detection', prompt)

        return {"anomalies": anomalies, "threat_analysis": response}