"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface AirspaceFeatureProperties {
  airspaceClass: string;
  name: string;
  ident: string;
  floor: string;
  ceiling: string;
  lowerFt: number;
  upperFt: number;
  touchesSurface: boolean;
}

interface AirspaceFeature {
  type: "Feature";
  properties: AirspaceFeatureProperties;
  geometry: {
    type: "Polygon";
    coordinates: number[][][];
  };
}

interface AirspaceGeoJSON {
  type: "FeatureCollection";
  features: AirspaceFeature[];
}

// Part 103 ultralight rules:
// Class G: Fly freely — uncontrolled airspace, no authorization needed
// Part 103 rules:
// B, C, D: RESTRICTED — need authorization/communication
// P (Prohibited): NO flight allowed
// R (Restricted): NO flight during active times
// MOA: Legal but dangerous (military training)
// W (Warning): Legal but hazardous
// A (Alert): Legal, be vigilant
// G: Fly freely
function isRestricted(airspaceClass: string): boolean {
  return ["B", "C", "D", "P", "R"].includes(airspaceClass);
}

function isCaution(airspaceClass: string): boolean {
  return ["MOA", "W", "A"].includes(airspaceClass);
}

function getLayerStyle(props: AirspaceFeatureProperties): {
  color: string;
  fillColor: string;
  fillOpacity: number;
  weight: number;
  dashArray?: string;
} {
  const cls = props.airspaceClass;

  // Prohibited — solid red, high visibility
  if (cls === "P") {
    return {
      color: "#dc2626",
      fillColor: "#dc2626",
      fillOpacity: 0.3,
      weight: 3,
    };
  }

  // Restricted — red hatched
  if (cls === "R") {
    return {
      color: "#ef4444",
      fillColor: "#ef4444",
      fillOpacity: 0.2,
      weight: 2,
      dashArray: "6,3",
    };
  }

  // MOA — orange
  if (cls === "MOA") {
    return {
      color: "#f97316",
      fillColor: "#f97316",
      fillOpacity: 0.12,
      weight: 2,
      dashArray: "10,5",
    };
  }

  // Warning — yellow/orange
  if (cls === "W") {
    return {
      color: "#eab308",
      fillColor: "#eab308",
      fillOpacity: 0.12,
      weight: 2,
      dashArray: "8,4",
    };
  }

  // Alert — yellow
  if (cls === "A" && !["B", "C", "D"].includes(cls)) {
    return {
      color: "#facc15",
      fillColor: "#facc15",
      fillOpacity: 0.1,
      weight: 1.5,
      dashArray: "6,6",
    };
  }

  // Class B, C, D (controlled airports)
  const restricted = isRestricted(cls);

  if (props.touchesSurface) {
    return {
      color: restricted ? "#ef4444" : "#22c55e",
      fillColor: restricted ? "#ef4444" : "#22c55e",
      fillOpacity: restricted ? 0.22 : 0.15,
      weight: 2,
    };
  }

  // Shelves / upper layers: dashed, lower opacity
  return {
    color: restricted ? "#f87171" : "#4ade80",
    fillColor: restricted ? "#f87171" : "#4ade80",
    fillOpacity: restricted ? 0.10 : 0.07,
    weight: 1.5,
    dashArray: "8,4",
  };
}

// Ray-casting point-in-polygon (for finding overlapping airspace on click)
function isPointInRing(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]; // lon
    const yi = ring[i][1]; // lat
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function isPointInFeature(lat: number, lon: number, feature: AirspaceFeature): boolean {
  const coords = feature.geometry.coordinates;
  if (!coords || coords.length === 0) return false;
  // Check outer ring
  return isPointInRing(lat, lon, coords[0]);
}

function buildPopupHTML(features: AirspaceFeatureProperties[]): string {
  if (features.length === 0) return "";

  // SUA type labels
  const suaLabels: Record<string, string> = {
    P: "Prohibited",
    R: "Restricted",
    MOA: "MOA",
    W: "Warning",
    A: "Alert",
    NSA: "Nat. Security",
  };

  const rows = features
    .map((p) => {
      const restricted = isRestricted(p.airspaceClass);
      const caution = isCaution(p.airspaceClass);
      const statusColor = restricted ? "#ef4444" : caution ? "#f97316" : "#22c55e";
      const statusText = restricted
        ? (p.airspaceClass === "P" ? "PROHIBITED" : "RESTRICTED")
        : caution
        ? "CAUTION"
        : "OK to fly";

      const isSUA = !!suaLabels[p.airspaceClass];
      const label = isSUA
        ? suaLabels[p.airspaceClass]
        : p.touchesSurface ? "Surface" : "Shelf";
      const classLabel = isSUA
        ? p.airspaceClass
        : `Class ${p.airspaceClass}`;

      let nameLine = "";
      if (p.ident && p.name && p.name !== p.ident) {
        nameLine = `<strong>${p.ident}</strong> &mdash; ${p.name}`;
      } else if (p.ident) {
        nameLine = `<strong>${p.ident}</strong>`;
      } else if (p.name) {
        nameLine = p.name;
      }

      return `
        <div style="padding:6px 0;${features.length > 1 ? "border-bottom:1px solid rgba(255,255,255,0.1);" : ""}">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
            <span style="
              display:inline-block;width:10px;height:10px;border-radius:2px;
              background:${statusColor};
            "></span>
            <strong style="font-size:15px;">${classLabel}</strong>
            <span style="font-size:11px;opacity:0.5;">${label}</span>
          </div>
          ${nameLine ? `<div style="font-size:12px;opacity:0.85;margin-left:16px;">${nameLine}</div>` : ""}
          <div style="font-size:12px;opacity:0.6;margin-left:16px;">
            ${p.floor} &mdash; ${p.ceiling}
          </div>
          <div style="font-size:11px;margin-left:16px;margin-top:2px;color:${statusColor};font-weight:600;">
            ${statusText}
          </div>
        </div>`;
    })
    .join("");

  const header =
    features.length > 1
      ? `<div style="font-size:11px;opacity:0.5;margin-bottom:4px;font-weight:600;">
           ${features.length} OVERLAPPING AIRSPACE LAYERS
         </div>`
      : "";

  return `<div style="font-family:system-ui;line-height:1.4;max-height:300px;overflow-y:auto;">${header}${rows}</div>`;
}

interface AirspaceMapProps {
  lat: number;
  lon: number;
  geoJSON: AirspaceGeoJSON;
}

export default function AirspaceMap({ lat, lon, geoJSON }: AirspaceMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;

    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    const map = L.map(mapRef.current, {
      center: [lat, lon],
      zoom: 10,
      zoomControl: true,
      attributionControl: true,
    });

    mapInstanceRef.current = map;

    // Dark tile layer
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        maxZoom: 16,
      }
    ).addTo(map);

    // Sort: draw upper/shelf layers first, surface layers on top
    const sortedFeatures = [...geoJSON.features].sort((a, b) => {
      if (a.properties.touchesSurface !== b.properties.touchesSurface) {
        return a.properties.touchesSurface ? 1 : -1;
      }
      return b.properties.upperFt - a.properties.upperFt;
    });

    // Add airspace polygons — but handle clicks ourselves for overlap support
    const allGeoLayers: L.Layer[] = [];

    for (const feature of sortedFeatures) {
      const style = getLayerStyle(feature.properties);

      const geoJsonLayer = L.geoJSON(
        {
          type: "Feature",
          properties: feature.properties,
          geometry: feature.geometry,
        } as GeoJSON.Feature,
        {
          style: () => style,
          interactive: false, // we handle clicks on the map level
        }
      );

      geoJsonLayer.addTo(map);
      allGeoLayers.push(geoJsonLayer);
    }

    // Handle map clicks: find ALL overlapping airspace at click point
    map.on("click", (e: L.LeafletMouseEvent) => {
      const clickLat = e.latlng.lat;
      const clickLon = e.latlng.lng;

      // Find all features containing this point
      const hitFeatures = geoJSON.features.filter((f) =>
        isPointInFeature(clickLat, clickLon, f)
      );

      if (hitFeatures.length > 0) {
        // Sort: most restrictive first
        const sorted = [...hitFeatures].sort((a, b) => {
          const pri: Record<string, number> = { B: 5, C: 4, D: 3, E: 2, A: 1 };
          return (pri[b.properties.airspaceClass] || 0) - (pri[a.properties.airspaceClass] || 0);
        });

        const html = buildPopupHTML(sorted.map((f) => f.properties));
        L.popup({ maxWidth: 320, className: "airspace-popup" })
          .setLatLng(e.latlng)
          .setContent(html)
          .openOn(map);
      }
    });

    // User location marker
    const userIcon = L.divIcon({
      html: `<div style="
        width:16px;height:16px;
        background:#38bdf8;
        border:3px solid #fff;
        border-radius:50%;
        box-shadow:0 0 8px rgba(56,189,248,0.6);
      "></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      className: "",
    });

    L.marker([lat, lon], { icon: userIcon })
      .addTo(map)
      .bindPopup("Your Location");

    // Zoom to ~10 mile diameter around user location
    // 5 mile radius ≈ 8047m. Use fitBounds with a circle's bounding box.
    const fiveMilesInDeg = 5 / 69; // ~0.0725 degrees
    map.fitBounds(
      [
        [lat - fiveMilesInDeg, lon - fiveMilesInDeg / Math.cos((lat * Math.PI) / 180)],
        [lat + fiveMilesInDeg, lon + fiveMilesInDeg / Math.cos((lat * Math.PI) / 180)],
      ],
      { padding: [10, 10] }
    );

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [lat, lon, geoJSON]);

  return (
    <div className="relative">
      <div
        ref={mapRef}
        className="w-full rounded-xl overflow-hidden border border-card-border"
        style={{ height: "400px" }}
      />
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm border-2"
            style={{ backgroundColor: "rgba(220,38,38,0.3)", borderColor: "#dc2626" }} />
          Prohibited
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm border-2"
            style={{ backgroundColor: "rgba(239,68,68,0.22)", borderColor: "#ef4444" }} />
          Restricted (B/C/D/R)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm border border-dashed"
            style={{ backgroundColor: "rgba(249,115,22,0.12)", borderColor: "#f97316" }} />
          MOA
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm border border-dashed"
            style={{ backgroundColor: "rgba(234,179,8,0.12)", borderColor: "#eab308" }} />
          Warning / Alert
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm border-2"
            style={{ backgroundColor: "rgba(34,197,94,0.15)", borderColor: "#22c55e" }} />
          Flyable
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full border-2"
            style={{ backgroundColor: "#38bdf8", borderColor: "#fff" }} />
          You
        </span>
      </div>
    </div>
  );
}
