import streamlit as st
import folium
from folium.plugins import MarkerCluster, HeatMap
from streamlit_folium import st_folium
import pandas as pd
import numpy as np
from datetime import datetime
import sqlite3
import json
from sklearn.ensemble import IsolationForest
from shapely.geometry import LineString, MultiLineString
import threading
import time
import os

# Custom CSS
def load_css():
    css = """
    <style>
    .main {background-color: #f0f8ff;}
    .sidebar .sidebar-content {background-color: #e6f0fa; margin-left: 50px; width: 300px;}
    .stButton>button {background-color: #1e90ff; color: white; border-radius: 5px;}
    .alert-box.speed {background-color: #ff4500;}
    .alert-box.piracy {background-color: #b22222;}
    .alert-box.boundary {background-color: #8b0000;}
    .alert-box {color: white; padding: 15px; border-radius: 5px; margin: 10px 0; font-weight: bold;}
    .alert-box.recent {animation: blink 1s infinite;}
    .alert-container {width: 350px; position: fixed; right: 10px; top: 100px; background-color: #fff; padding: 10px; border-radius: 5px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); max-height: 600px; overflow-y: auto;}
    .map-container {width: 100%; margin-left: -300px; padding-right: 370px;}
    .modal {background-color: #fff; padding: 20px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.2);}
    @keyframes blink {
        50% {opacity: 0.5;}
    }
    </style>
    """
    return css

# JavaScript for custom audio beep sound
def load_js():
    js = r"""
    <script>
    function playBeep() {
        var audio = new Audio('https://www.soundjay.com/buttons/beep-01a.mp3'); // Replace with your audio URL
        var endTime = Date.now() + 10000; // Play for 10 seconds

        function playLoop() {
            if (Date.now() < endTime) {
                audio.currentTime = 0; // Reset to start
                audio.play().then(() => {
                    setTimeout(playLoop, 500); // Beep every 0.5 seconds
                }).catch(error => {
                    console.error("Audio playback failed:", error);
                    document.body.innerHTML += "<p>Audio error: " + error.message + "</p>";
                });
            }
        }
        playLoop();
    }
    </script>
    """
    return js

# Database setup
def init_db(db_name='vessel_data.db'):
    conn = sqlite3.connect(db_name)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS vessels (
            vessel_id TEXT PRIMARY KEY,
            lat REAL, lon REAL, speed REAL, heading REAL, timestamp REAL,
            trajectory TEXT, is_friendly INTEGER
        )
    ''')
    conn.commit()
    conn.close()

# Load and save data
def load_ais_data(db_name='vessel_data.db'):
    conn = sqlite3.connect(db_name)
    df = pd.read_sql_query("SELECT * FROM vessels", conn)
    conn.close()
    df['trajectory'] = df['trajectory'].apply(lambda x: json.loads(x) if x and x != 'null' else None)
    df['is_friendly'] = df.get('is_friendly', 1)
    return df

def save_vessel_to_db(vessel_data, trajectory=None, is_friendly=1, db_name='vessel_data.db'):
    conn = sqlite3.connect(db_name)
    c = conn.cursor()
    trajectory_json = json.dumps(trajectory) if trajectory else None
    c.execute('''
        INSERT OR REPLACE INTO vessels (vessel_id, lat, lon, speed, heading, timestamp, trajectory, is_friendly)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ''', (vessel_data['vessel_id'], vessel_data['lat'], vessel_data['lon'],
          vessel_data['speed'], vessel_data['heading'], vessel_data['timestamp'],
          trajectory_json, is_friendly))
    conn.commit()
    conn.close()

def remove_vessel_from_db(vessel_id, db_name='vessel_data.db'):
    conn = sqlite3.connect(db_name)
    c = conn.cursor()
    c.execute("DELETE FROM vessels WHERE vessel_id = ?", (vessel_id,))
    conn.commit()
    conn.close()

# Generate initial data
def generate_initial_ais_data(db_name='vessel_data.db'):
    np.random.seed(42)
    n_vessels = 10
    base_time = datetime.now().timestamp()
    regions = [(23.5, 64.5), (15.0, 64.5), (5.0, 69.5), (4.0, 76.0), (4.0, 84.0),
               (6.0, 87.5), (15.0, 93.0), (20.0, 92.0), (12.0, 44.0), (2.0, 99.0)]
    df = pd.DataFrame({
        'vessel_id': [f"VESSEL{str(i).zfill(3)}" for i in range(1, n_vessels + 1)],
        'lat': [r[0] + np.random.uniform(-0.5, 0.5) for r in regions[:n_vessels]],
        'lon': [r[1] + np.random.uniform(-0.5, 0.5) for r in regions[:n_vessels]],
        'speed': np.random.uniform(5, 20, n_vessels),
        'heading': np.random.uniform(0, 360, n_vessels),
        'timestamp': [base_time - i * 300 for i in range(n_vessels)],
        'trajectory': [None] * n_vessels,
        'is_friendly': np.random.randint(0, 2, n_vessels)
    })
    for _, row in df.iterrows():
        save_vessel_to_db(row, None, row['is_friendly'], db_name)
    return df

# Real-time data simulation
def update_ais_data(df):
    df['timestamp'] += 60
    lat_change = np.sin(np.radians(df['heading'])) * df['speed'] * 0.0001
    lon_change = np.cos(np.radians(df['heading'])) * df['speed'] * 0.0001
    df['lat'] += lat_change
    df['lon'] += lon_change
    df['speed'] = df['speed'].clip(0, 25)
    for _, row in df.iterrows():
        save_vessel_to_db(row, row['trajectory'], row['is_friendly'])
    return df

# Risk and anomaly detection
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

def detect_anomalies(df, contamination=0.1):
    if df.empty:
        return df
    features = df[['speed', 'heading']].fillna(0)
    iso_forest = IsolationForest(contamination=contamination, random_state=42)
    df['anomaly'] = iso_forest.fit_predict(features)
    df['risk_score'] = df.apply(calculate_risk_score, axis=1)
    return df

# Alerts
def generate_alerts(vessel_info, trajectories, maritime_boundary):
    alerts = []
    if vessel_info['speed'] and vessel_info['speed'] > 12:
        alerts.append(('speed', f"High Speed: {vessel_info['vessel_id']} at {vessel_info['speed']:.1f} knots"))
    if vessel_info['lat'] and vessel_info['lon']:
        if 10 <= vessel_info['lat'] <= 15 and 43 <= vessel_info['lon'] <= 53:
            alerts.append(('piracy', f"Piracy Risk: {vessel_info['vessel_id']} in Gulf of Aden"))
        elif 0 <= vessel_info['lat'] <= 5 and 65 <= vessel_info['lon'] <= 70:
            alerts.append(('piracy', f"Piracy Risk: {vessel_info['vessel_id']} in Arabian Sea near Horn of Africa"))
        elif 0 <= vessel_info['lat'] <= 5 and 97 <= vessel_info['lon'] <= 102:
            alerts.append(('piracy', f"Piracy Risk: {vessel_info['vessel_id']} in Malacca Strait"))
    
    if vessel_info['is_friendly'] == 0 and vessel_info['vessel_id'] in trajectories:
        trajectory = trajectories[vessel_info['vessel_id']]
        if trajectory and check_boundary_crossing(trajectory, maritime_boundary):
            alert_msg = f"Boundary Violation: Non-Friendly {vessel_info['vessel_id']} crossed Indian maritime boundary"
            if vessel_info['speed'] > 12:
                alert_msg += f" at {vessel_info['speed']:.1f} knots"
            alerts.append(('boundary', alert_msg))
    return alerts

def check_boundary_crossing(trajectory, boundary):
    try:
        traj_line = LineString(trajectory)
        boundary_lines = MultiLineString([LineString([boundary[i], boundary[(i + 1) % len(boundary)]]) for i in range(len(boundary))])
        return traj_line.intersects(boundary_lines)
    except Exception:
        return False

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

# Map setup
def setup_map(df, center, zoom, style, trajectories, show_heatmap, show_pins):
    m = folium.Map(location=center, zoom_start=zoom, tiles=style)
    maritime_boundary = [[23.5, 64.5], [15.0, 64.5], [5.0, 69.5], [4.0, 76.0], [4.0, 84.0], [6.0, 87.5], [15.0, 93.0], [23.5, 90.0]]
    folium.PolyLine(locations=maritime_boundary, color='#0066cc', weight=1, opacity=0.8, dash_array='5, 5').add_to(m)
    
    folium.Rectangle(
        bounds=[[10, 43], [15, 53]], 
        color='red', 
        fill=True, 
        fill_opacity=0.1, 
        tooltip="Piracy Risk: Gulf of Aden"
    ).add_to(m)
    folium.Rectangle(
        bounds=[[0, 65], [5, 70]], 
        color='red', 
        fill=True, 
        fill_opacity=0.1, 
        tooltip="Piracy Risk: Arabian Sea"
    ).add_to(m)
    folium.Rectangle(
        bounds=[[0, 97], [5, 102]], 
        color='red', 
        fill=True, 
        fill_opacity=0.1, 
        tooltip="Piracy Risk: Malacca Strait"
    ).add_to(m)

    if show_pins:
        marker_cluster = MarkerCluster().add_to(m)
        for _, row in df.iterrows():
            color = 'orange' if row['risk_score'] > 30 else 'green' if row['is_friendly'] else 'red'
            popup_html = f"<b>{row['vessel_id']}</b><br>Speed: {row['speed']:.1f} knots<br>Risk: {row['risk_score']}"
            folium.Marker([row['lat'], row['lon']], popup=popup_html, icon=folium.Icon(color=color, icon='ship', prefix='fa')).add_to(marker_cluster)
    if trajectories:
        for vessel_id, traj in trajectories.items():
            if traj:
                folium.PolyLine(locations=traj, color='orange', weight=3, dash_array='5, 5', tooltip=f"Trajectory: {vessel_id}").add_to(m)
    if show_heatmap and len(df) > 3:
        HeatMap(df[['lat', 'lon']].values).add_to(m)
    folium.LayerControl().add_to(m)
    return m

# Real-time update simulation
def run_realtime_updates():
    while True:
        if 'ais_data' in st.session_state:
            st.session_state.ais_data = update_ais_data(st.session_state.ais_data)
            st.session_state.map_key += 1
            st.rerun()
        time.sleep(60)

# Main app
def main():
    st.set_page_config(page_title="Maritime Dashboard", layout="wide")
    st.markdown(load_css(), unsafe_allow_html=True)

    init_db()
    if 'ais_data' not in st.session_state:
        ais_data = load_ais_data()
        st.session_state.ais_data = ais_data if not ais_data.empty else generate_initial_ais_data()
    if 'map_key' not in st.session_state:
        st.session_state.map_key = 0
    if 'new_alerts' not in st.session_state:
        st.session_state.new_alerts = []
    if 'trajectories' not in st.session_state:
        st.session_state.trajectories = {row['vessel_id']: row['trajectory'] for _, row in st.session_state.ais_data.iterrows() if row['trajectory']}

    maritime_boundary = [[23.5, 64.5], [15.0, 64.5], [5.0, 69.5], [4.0, 76.0], [4.0, 84.0], [6.0, 87.5], [15.0, 93.0], [23.5, 90.0]]

    with st.sidebar:
        st.header("⚙ Controls")
        min_speed = st.slider("Min Speed (knots)", 0, 20, 0)
        map_style = st.selectbox("Map Style", ["openstreetmap", "cartodbpositron"])
        zoom_level = st.slider("Zoom Level", 4, 12, 5)
        show_heatmap = st.checkbox("Show Heatmap", value=True)
        show_pins = st.checkbox("Show Vessel Pins", value=True)
        if st.button("Manual Update"):
            st.session_state.ais_data = update_ais_data(st.session_state.ais_data)
            st.session_state.map_key += 1

        st.subheader("➕ Add Vessel")
        with st.form("add_vessel_form"):
            vessel_id = st.text_input("Vessel ID", value=f"VESSEL{len(st.session_state.ais_data) + 1:03d}")
            lat = st.number_input("Latitude", -90.0, 90.0, 20.0)
            lon = st.number_input("Longitude", -180.0, 180.0, 78.0)
            speed = st.number_input("Speed (knots)", 0.0, 25.0, 10.0)
            heading = st.number_input("Heading (degrees)", 0.0, 360.0, 0.0)
            time_minutes = st.number_input("Prediction Time (minutes)", 60, 1440, 60)
            is_friendly = st.selectbox("Status", ["Friendly", "Non-Friendly"]) == "Friendly"
            if st.form_submit_button("Add"):
                new_vessel = {'vessel_id': vessel_id, 'lat': lat, 'lon': lon, 'speed': speed, 'heading': heading, 'timestamp': datetime.now().timestamp()}
                trajectory = predict_trajectory(lat, lon, speed, heading, time_minutes)
                save_vessel_to_db(new_vessel, trajectory, 1 if is_friendly else 0)
                st.session_state.trajectories[vessel_id] = trajectory
                st.session_state.ais_data = load_ais_data()
                st.session_state.map_key += 1

        st.subheader("🗑️ Remove Vessel")
        with st.form("remove_vessel_form"):
            remove_vessel_id = st.selectbox("Select Vessel to Remove", st.session_state.ais_data['vessel_id'].tolist())
            if st.form_submit_button("Remove"):
                remove_vessel_from_db(remove_vessel_id)
                if remove_vessel_id in st.session_state.trajectories:
                    del st.session_state.trajectories[remove_vessel_id]
                st.session_state.ais_data = load_ais_data()
                st.session_state.map_key += 1

    st.session_state.ais_data = detect_anomalies(st.session_state.ais_data)
    filtered_data = st.session_state.ais_data[st.session_state.ais_data['speed'] >= min_speed]

    col1, col2 = st.columns([8, 2])

    with col1:
        center = [filtered_data['lat'].mean(), filtered_data['lon'].mean()] if not filtered_data.empty else [20.5937, 78.9629]
        m = setup_map(filtered_data, center, zoom_level, map_style, st.session_state.trajectories, show_heatmap, show_pins)
        st_folium(m, width=1000, height=800, key=f"map_{st.session_state.map_key}")

        # Vessel Data Table below the map
        st.subheader("Vessel Data")
        display_data = filtered_data[['vessel_id', 'lat', 'lon', 'speed', 'heading', 'is_friendly', 'risk_score']].copy()
        display_data['is_friendly'] = display_data['is_friendly'].map({1: 'Friendly', 0: 'Non-Friendly'})
        display_data = display_data.rename(columns={
            'vessel_id': 'ID',
            'lat': 'Latitude',
            'lon': 'Longitude',
            'speed': 'Speed (knots)',
            'heading': 'Heading (°)',
            'is_friendly': 'Status',
            'risk_score': 'Risk Score'
        })
        st.dataframe(display_data)

    with col2:
        st.markdown("<div class='alert-container'>", unsafe_allow_html=True)
        st.markdown("### 🚨 Alerts")
        if st.button("Play Alert Sound"):
            st.markdown(load_js(), unsafe_allow_html=True)
            st.markdown("<script>playBeep();</script>", unsafe_allow_html=True)
        current_time = datetime.now().timestamp()
        all_alerts = []
        
        # Track new alerts
        new_alerts = []
        for _, row in filtered_data.iterrows():
            alerts = generate_alerts(row, st.session_state.trajectories, maritime_boundary)
            for alert_type, alert_msg in alerts:
                alert_time = row['timestamp']
                is_recent = (current_time - alert_time) < 300  # Within last 5 minutes
                all_alerts.append((alert_type, alert_msg, is_recent))
                if is_recent and (alert_type, alert_msg) not in st.session_state.new_alerts:
                    new_alerts.append((alert_type, alert_msg))

        # Update session state with new alerts and trigger beep
        if new_alerts:
            st.session_state.new_alerts.extend(new_alerts)
            st.markdown(load_js(), unsafe_allow_html=True)
            st.markdown("<script>playBeep();</script>", unsafe_allow_html=True)

        # Separate recent and older alerts
        recent_alerts = [(at, am, ir) for at, am, ir in all_alerts if ir]
        older_alerts = [(at, am, ir) for at, am, ir in all_alerts if not ir]

        # Display recent alerts first
        for alert_type, alert_msg, is_recent in recent_alerts:
            class_name = f"alert-box {alert_type} recent"
            st.markdown(f"<div class='{class_name}'>{alert_msg}</div>", unsafe_allow_html=True)

        # Then display older alerts
        for alert_type, alert_msg, _ in older_alerts:
            class_name = f"alert-box {alert_type}"
            st.markdown(f"<div class='{class_name}'>{alert_msg}</div>", unsafe_allow_html=True)
        
        # Clear old alerts from session state
        st.session_state.new_alerts = [(t, m) for t, m in st.session_state.new_alerts 
                                     if any((t == at and m == am and ir) for at, am, ir in all_alerts)]
        
        st.markdown("</div>", unsafe_allow_html=True)

    threading.Thread(target=run_realtime_updates, daemon=True).start()

# Unit Tests
import unittest

class TestMaritimeDashboard(unittest.TestCase):
    def setUp(self):
        self.db_name = 'test_vessel_data.db'
        if os.path.exists(self.db_name):
            os.remove(self.db_name)
        init_db(self.db_name)
        generate_initial_ais_data(self.db_name)

    def tearDown(self):
        if os.path.exists(self.db_name):
            os.remove(self.db_name)

    def test_load_ais_data(self):
        df = load_ais_data(self.db_name)
        self.assertFalse(df.empty)
        self.assertEqual(len(df), 10)

    def test_save_vessel(self):
        vessel = {'vessel_id': 'TEST001', 'lat': 20.0, 'lon': 78.0, 'speed': 10.0, 'heading': 90.0, 'timestamp': datetime.now().timestamp()}
        save_vessel_to_db(vessel, None, 1, self.db_name)
        df = load_ais_data(self.db_name)
        self.assertIn('TEST001', df['vessel_id'].values)

    def test_risk_score(self):
        row = pd.Series({'speed': 15, 'lat': 12, 'lon': 45, 'anomaly': -1})
        score = calculate_risk_score(row)
        self.assertEqual(score, 100)

if __name__ == "__main__":
    main()  # Run the Streamlit app
    # To run tests, comment out the above line and uncomment the below line, then run with `python -m unittest adv.py`
    # unittest.main(argv=['first-arg-is-ignored'], exit=False)