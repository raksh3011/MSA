import numpy as np
import json
from sklearn.ensemble import IsolationForest
from shapely.geometry import LineString, MultiLineString
from datetime import datetime
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import Chroma
from langchain_community.document_loaders import PyPDFLoader
from langchain.chains import RetrievalQA
import easyocr
import cv2


# Trajectory prediction
def predict_trajectory(lat, lon, speed, heading, time_minutes, steps=10):
    speed_km_per_min = speed * 1.852 / 60
    step_time = time_minutes / steps
    trajectory = [[lat, lon]]
    for _ in range(steps):
        distance_km = speed_km_per_min * step_time
        distance_deg = distance_km / 111
        heading_rad = np.radians(heading)
        lat += distance_deg * np.cos(heading_rad)
        lon += distance_deg * np.sin(heading_rad) / np.cos(np.radians(lat))
        trajectory.append([lat, lon])
    return trajectory

# Anomaly detection
def detect_anomalies(df, contamination=0.1):
    if df.empty:
        return df
    features = df[['speed', 'heading']].fillna(0)
    iso_forest = IsolationForest(contamination=contamination, random_state=42)
    df['anomaly'] = iso_forest.fit_predict(features)
    df['risk_score'] = df.apply(calculate_risk_score, axis=1)
    return df

def calculate_risk_score(row, speed_threshold=12, anomaly_weight=30):
    score = 0
    if row['speed'] > speed_threshold:
        score += 40
    if (10 <= row['lat'] <= 15 and 43 <= row['lon'] <= 53) or \
       (0 <= row['lat'] <= 5 and 65 <= row['lon'] <= 70) or \
       (0 <= row['lat'] <= 5 and 97 <= row['lon'] <= 102):
        score += 30
    if row.get('anomaly', 1) == -1:
        score += anomaly_weight
    return min(score, 100)

# RAG setup
embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
vectorstore = Chroma(embedding_function=embeddings, collection_name="naval_docs")

def add_document_to_rag(file_path):
    loader = PyPDFLoader(file_path)
    docs = loader.load_and_split()
    vectorstore.add_documents(docs)

def query_rag(query):
    llm = Anthropic(model="claude-3-sonnet-20240229", api_key=Config.ANTHROPIC_API_KEY)
    qa = RetrievalQA.from_chain_type(llm=llm, chain_type="stuff", retriever=vectorstore.as_retriever())
    return qa.run(query)

# OCR functionality
reader = easyocr.Reader(['en'])

def perform_ocr(image_path):
    image = cv2.imread(image_path)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    result = reader.readtext(gray)
    text = ' '.join([detection[1] for detection in result])
    return text

# Boundary crossing
def check_boundary_crossing(trajectory, boundary):
    try:
        traj_line = LineString(trajectory)
        boundary_lines = MultiLineString([LineString([boundary[i], boundary[(i + 1) % len(boundary)]]) for i in range(len(boundary))])
        return traj_line.intersects(boundary_lines)
    except Exception:
        return False