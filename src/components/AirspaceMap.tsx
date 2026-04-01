"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface AirspaceFeatureProperties {
  airspaceClass: string;
  name: string;
  floor: string;
  ceiling: string;
  lowerFt: number;
  upperFt: number;
  touchesSurface: boolean;
}

interface AirspaceGeoJSON {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: AirspaceFeatureProperties;
    geometry: {
      type: "Polygon";
      coordinates: number[][][];
    };
  }[];
}

// Color scheme for airspace layers based on altitude
function getLayerStyle(props: AirspaceFeatureProperties): {
  color: string;
  fillColor: string;
  fillOpacity: number;
  weight: number;
  dashArray?: string;
} {
  const cls = props.airspaceClass;

  // Surface-level airspace: solid, more opaque
  if (props.touchesSurface) {
    switch (cls) {
      case "B":
        return {
          color: "#3b82f6",
          fillColor: "#3b82f6",
          fillOpacity: 0.25,
          weight: 2,
        };
      case "C":
        return {
          color: "#a855f7",
          fillColor: "#a855f7",
          fillOpacity: 0.25,
          weight: 2,
        };
      case "D":
        return {
          color: "#3b82f6",
          fillColor: "#3b82f6",
          fillOpacity: 0.2,
          weight: 2,
          dashArray: "5,5",
        };
      case "E":
        return {
          color: "#f43f5e",
          fillColor: "#f43f5e",
          fillOpacity: 0.1,
          weight: 1,
        };
      default:
        return {
          color: "#94a3b8",
          fillColor: "#94a3b8",
          fillOpacity: 0.05,
          weight: 1,
        };
    }
  }

  // Shelves / upper layers: dashed, lower opacity
  switch (cls) {
    case "B":
      return {
        color: "#60a5fa",
        fillColor: "#60a5fa",
        fillOpacity: 0.12,
        weight: 1.5,
        dashArray: "8,4",
      };
    case "C":
      return {
        color: "#c084fc",
        fillColor: "#c084fc",
        fillOpacity: 0.12,
        weight: 1.5,
        dashArray: "8,4",
      };
    case "D":
      return {
        color: "#60a5fa",
        fillColor: "#60a5fa",
        fillOpacity: 0.08,
        weight: 1,
        dashArray: "4,4",
      };
    case "E":
      return {
        color: "#f87171",
        fillColor: "#f87171",
        fillOpacity: 0.06,
        weight: 1,
        dashArray: "4,8",
      };
    default:
      return {
        color: "#94a3b8",
        fillColor: "#94a3b8",
        fillOpacity: 0.03,
        weight: 1,
        dashArray: "2,6",
      };
  }
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

    // Clean up previous map
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

    // Sort features: draw larger/upper layers first, surface layers on top
    const sortedFeatures = [...geoJSON.features].sort((a, b) => {
      // Surface layers should render on top (drawn last)
      if (a.properties.touchesSurface !== b.properties.touchesSurface) {
        return a.properties.touchesSurface ? 1 : -1;
      }
      // Among same type, draw larger (higher ceiling) first
      return b.properties.upperFt - a.properties.upperFt;
    });

    // Add airspace polygons
    for (const feature of sortedFeatures) {
      const style = getLayerStyle(feature.properties);
      const { airspaceClass, name, floor, ceiling, touchesSurface } =
        feature.properties;

      // Leaflet GeoJSON expects [lat, lng] but GeoJSON/ArcGIS uses [lng, lat]
      // L.geoJSON handles this automatically
      const geoJsonLayer = L.geoJSON(
        {
          type: "Feature",
          properties: feature.properties,
          geometry: feature.geometry,
        } as GeoJSON.Feature,
        {
          style: () => style,
          onEachFeature: (_feat, layer) => {
            const label = touchesSurface ? "Surface" : "Shelf/Upper";
            layer.bindPopup(
              `<div style="font-family:system-ui;font-size:13px;line-height:1.4">
                <strong style="font-size:15px">Class ${airspaceClass}</strong>
                <span style="opacity:0.6;margin-left:4px">${label}</span>
                <br/>
                ${name ? `<span style="opacity:0.8">${name}</span><br/>` : ""}
                <span style="opacity:0.7">${floor} &mdash; ${ceiling}</span>
              </div>`,
              { className: "airspace-popup" }
            );
          },
        }
      );

      geoJsonLayer.addTo(map);
    }

    // Add user location marker
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
      .bindPopup("Your Location")
      .openPopup();

    // Fit bounds to show all airspace, or at least center on user
    if (geoJSON.features.length > 0) {
      try {
        const allLayers = L.geoJSON({
          type: "FeatureCollection",
          features: sortedFeatures,
        } as GeoJSON.FeatureCollection);
        const bounds = allLayers.getBounds();
        if (bounds.isValid()) {
          // Extend bounds to include user location
          bounds.extend([lat, lon]);
          map.fitBounds(bounds, { padding: [30, 30], maxZoom: 11 });
        }
      } catch {
        map.setView([lat, lon], 10);
      }
    }

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
        style={{ height: "380px" }}
      />
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm border"
            style={{
              backgroundColor: "rgba(59,130,246,0.25)",
              borderColor: "#3b82f6",
            }}
          />
          Class B (surface)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm border border-dashed"
            style={{
              backgroundColor: "rgba(96,165,250,0.12)",
              borderColor: "#60a5fa",
            }}
          />
          Class B (shelf)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm border"
            style={{
              backgroundColor: "rgba(168,85,247,0.25)",
              borderColor: "#a855f7",
            }}
          />
          Class C (surface)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm border border-dashed"
            style={{
              backgroundColor: "rgba(192,132,252,0.12)",
              borderColor: "#c084fc",
            }}
          />
          Class C (shelf)
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm border border-dashed"
            style={{
              backgroundColor: "rgba(59,130,246,0.2)",
              borderColor: "#3b82f6",
            }}
          />
          Class D
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-3 rounded-sm border"
            style={{
              backgroundColor: "rgba(244,63,94,0.1)",
              borderColor: "#f43f5e",
            }}
          />
          Class E
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full border-2"
            style={{
              backgroundColor: "#38bdf8",
              borderColor: "#fff",
            }}
          />
          You
        </span>
      </div>
    </div>
  );
}
