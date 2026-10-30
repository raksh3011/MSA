"""Dev check: make sure no simulator route crosses land (Natural Earth 1:10m).
Usage: python scripts/check_routes.py <countries.geojson> <routes.json>   (routes.json from scripts/probe.ts)
"""
import json
import sys

import shapely
from shapely.geometry import LineString, shape

geoms = [shape(f["geometry"]) for f in json.load(open(sys.argv[1], encoding="utf8"))["features"]]
tree = shapely.STRtree(geoms)
routes = json.load(open(sys.argv[2], encoding="utf8"))
bad = 0
for name, pts in routes.items():
    line = LineString([(lon, lat) for lat, lon in pts]).buffer(0.03)  # ~3 km clearance
    hits = tree.query(line, predicate="intersects")
    if len(hits):
        bad += 1
        print("LAND CROSSING:", name)
print("routes checked:", len(routes), "problems:", bad)
