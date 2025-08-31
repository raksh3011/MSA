from langgraph import Graph
from app.agents.detection_agent import DetectionAgent
from app.agents.analysis_agent import AnalysisAgent
from app.agents.response_agent import ResponseAgent

def orchestrate_workflow(mcp, input_data):
    graph = Graph()

    detection = DetectionAgent(mcp)
    analysis = AnalysisAgent(mcp)
    response = ResponseAgent(mcp)

    graph.add_node("detection", detection.run)
    graph.add_node("analysis", analysis.run)
    graph.add_node("response", response.run)

    graph.add_edge("detection", "analysis")
    graph.add_edge("analysis", "response")

    graph.set_entry_point("detection")
    graph.set_finish_point("response")

    result = graph.invoke(input_data)
    return result