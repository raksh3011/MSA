"""
Build maritime zone geometry for ORVMS from real coastlines.

Input : Natural Earth 1:10m admin-0 countries (public domain), downloaded separately:
        https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson
Output: src/core/zones.data.json  (committed; the app never needs Python at runtime)

Method (UNCLOS-style, modelled -- NOT the official gazetted limits):
  * territorial sea  = sea within 12 nm of Indian land
  * contiguous zone  = 12-24 nm
  * EEZ              = sea within 200 nm of Indian land
  * Where neighbouring coasts are closer than 200 nm, the limit is the equidistance (median) line:
    each sea point is owned by the nearest coast (Voronoi cells over densified coastlines).
  * The shared edges between India's cells and a neighbour's cells are the "modelled maritime boundary".

Usage:  python scripts/build_zones.py <natural-earth-countries.geojson>
Requires: shapely>=2, pyproj
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import shapely
from pyproj import Transformer
from shapely.geometry import MultiPoint, MultiPolygon, Point, Polygon, box, shape
from shapely.ops import linemerge, transform, unary_union

NM = 1852.0
SRC = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent.parent / "src" / "core" / "zones.data.json"

NEIGHBOURS = {
    "PAK": "Pakistan", "LKA": "Sri Lanka", "BGD": "Bangladesh", "MMR": "Myanmar",
    "MDV": "Maldives", "IDN": "Indonesia", "THA": "Thailand", "OMN": "Oman", "MYS": "Malaysia",
}
LAKSHADWEEP = [  # (lat, lon, radius km) island groups missing at 1:10m detail
    (10.57, 72.64, 4), (10.86, 72.18, 4), (10.80, 73.67, 3), (8.28, 73.05, 4), (11.12, 72.73, 3),
]

fwd = Transformer.from_crs("EPSG:4326", "+proj=lcc +lat_1=6 +lat_2=22 +lat_0=14 +lon_0=80 +datum=WGS84 +units=m", always_xy=True)
inv = Transformer.from_crs("+proj=lcc +lat_1=6 +lat_2=22 +lat_0=14 +lon_0=80 +datum=WGS84 +units=m", "EPSG:4326", always_xy=True)
project = lambda g: transform(fwd.transform, g)
unproject = lambda g: transform(inv.transform, g)

LL_BBOX = box(46, -14, 112, 36)

print("loading", SRC)
data = json.loads(SRC.read_text(encoding="utf8"))
by_code = defaultdict(list)
for f in data["features"]:
    code = f["properties"].get("ADM0_A3") or f["properties"].get("ISO_A3")
    g = shape(f["geometry"]).intersection(LL_BBOX)
    if not g.is_empty:
        by_code[code].append(g)

land = {c: project(unary_union(gs)) for c, gs in by_code.items()}
# Lakshadweep fix-up
lak = [Point(*fwd.transform(lon, lat)).buffer(r * 1000) for lat, lon, r in LAKSHADWEEP]
land["IND"] = unary_union([land["IND"], *lak])
all_land = unary_union(list(land.values()))
print("countries in bbox:", len(land))

owners = ["IND", *NEIGHBOURS.keys()]
pts, pt_owner, seen = [], [], set()
for code in owners:
    if code not in land:
        continue
    geoms = land[code].geoms if hasattr(land[code], "geoms") else [land[code]]
    for poly in geoms:
        if not isinstance(poly, Polygon):
            continue
        ring = shapely.segmentize(poly.exterior, NM * 1.5)
        for x, y in ring.coords:
            key = (round(x / 150), round(y / 150))
            if key in seen:
                continue
            seen.add(key)
            pts.append(Point(x, y))
            pt_owner.append(code)
print("coast points:", len(pts))

extent = project(box(44, -16, 114, 38))
cells = shapely.voronoi_polygons(MultiPoint(pts), extend_to=extent)
cell_list = list(cells.geoms)
tree = shapely.STRtree(pts)
pair = tree.query(cell_list, predicate="contains")  # (cell_idx, point_idx)
region = defaultdict(list)
for ci, pi in zip(pair[0], pair[1]):
    region[pt_owner[pi]].append(cell_list[ci])
region = {c: unary_union(v) for c, v in region.items()}
print({c: round(g.area / 1e12, 2) for c, g in region.items()})

india = land["IND"]
sea_only = lambda g: g.difference(all_land)
r_ind = region["IND"]
b12, b24, b200 = (india.buffer(n * NM, quad_segs=8) for n in (12, 24, 200))
territorial = sea_only(b12.intersection(r_ind))
contiguous = sea_only(b24.difference(b12).intersection(r_ind))
eez = sea_only(b200.intersection(r_ind))

near_india = india.buffer(320 * NM, quad_segs=6)
neighbours_out, boundaries_out = [], []
for code, name in NEIGHBOURS.items():
    if code not in region or code not in land:
        continue
    r_n = region[code]
    eez_n = sea_only(r_n.intersection(land[code].buffer(200 * NM, quad_segs=8))).intersection(near_india)
    if eez_n.is_empty or eez_n.area < (20 * NM) ** 2:
        continue
    shared = r_ind.boundary.intersection(r_n.buffer(800))
    shared = shared.intersection(b200.buffer(10 * NM)).difference(all_land.buffer(2500))
    lines = []
    for g in (shared.geoms if hasattr(shared, "geoms") else [shared]):
        if g.geom_type in ("LineString", "MultiLineString"):
            merged = linemerge(g) if g.geom_type == "MultiLineString" else g
            for part in (merged.geoms if hasattr(merged, "geoms") else [merged]):
                if part.length > 8 * NM:
                    lines.append(part)
    neighbours_out.append((code, name, eez_n))
    boundaries_out.append((code, name, lines))


def polys(g):
    if g.is_empty:
        return []
    return [p for p in (g.geoms if hasattr(g, "geoms") else [g]) if isinstance(p, Polygon)]


def ring_ll(ring, nd):
    return [[round(lat, nd), round(lon, nd)] for lon, lat in ring.coords]


def poly_out(p, tol_m, nd, min_area_nm2=40):
    p = unproject(p.simplify(tol_m, preserve_topology=True))
    if p.area == 0:
        return None
    rings = [ring_ll(p.exterior, nd)] + [ring_ll(h, nd) for h in p.interiors if Polygon(h).area > 0]
    return rings


def mp_out(g, tol_m, nd, min_area_nm2=30):
    out = []
    for p in polys(g):
        if p.area < min_area_nm2 * NM * NM:
            continue
        # drop tiny holes
        p = Polygon(p.exterior, [h for h in p.interiors if Polygon(h).area > min_area_nm2 * NM * NM])
        r = poly_out(p, tol_m, nd)
        if r and len(r[0]) >= 4:
            out.append(r)
    return out


def lines_out(lines, tol_m, nd):
    out = []
    for l in lines:
        l = unproject(l.simplify(tol_m))
        out.append([[round(lat, nd), round(lon, nd)] for lon, lat in l.coords])
    return out


result = {
    "meta": {
        "generated_by": "scripts/build_zones.py",
        "source": "Natural Earth 1:10m admin-0 countries (public domain)",
        "method": "Modelled UNCLOS limits: 12/24/200 nm from Indian land, equidistance with neighbours. NOT official gazetted limits.",
    },
    "territorial": mp_out(territorial, 350, 3, 5),
    "contiguous": mp_out(contiguous, 500, 3, 10),
    "eez": mp_out(eez, 900, 2, 50),
    "neighbours": [
        {"code": c, "name": n, "eez": mp_out(g, 1500, 2, 80)} for c, n, g in neighbours_out
    ],
    "boundaries": [
        {"code": c, "name": f"India - {n}", "lines": lines_out(ls, 700, 3)} for c, n, ls in boundaries_out if ls
    ],
}
OUT.write_text(json.dumps(result, separators=(",", ":")), encoding="utf8")
size = OUT.stat().st_size
print("wrote", OUT, f"{size/1024:.0f} KB")
for k in ("territorial", "contiguous", "eez"):
    print(k, "polygons:", len(result[k]), "vertices:", sum(len(r[0]) for r in result[k]))
for n in result["neighbours"]:
    print(" neighbour", n["code"], "polygons:", len(n["eez"]), "vertices:", sum(len(r[0]) for r in n["eez"]))
for b in result["boundaries"]:
    print(" boundary", b["name"], "lines:", len(b["lines"]), "vertices:", sum(len(l) for l in b["lines"]))
