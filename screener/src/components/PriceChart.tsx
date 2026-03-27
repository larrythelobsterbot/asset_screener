"use client";

import { useEffect, useRef } from "react";

interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Props {
  candles: CandleData[];
  indicators: {
    ema13: (number | null)[];
    ema25: (number | null)[];
    ema32: (number | null)[];
    ma100: (number | null)[];
    ma300: (number | null)[];
    ema200: (number | null)[];
  };
}

const MA_COLORS: Record<string, string> = {
  ema13: "#3B82F6",
  ema25: "#F59E0B",
  ema32: "#10B981",
  ma100: "#8B5CF6",
  ma300: "#F43F5E",
  ema200: "#06B6D4",
};

export default function PriceChart({ candles, indicators }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current || !candles.length) return;

    let mounted = true;

    import("lightweight-charts").then((lc) => {
      if (!mounted || !containerRef.current) return;

      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }

      const chart = lc.createChart(containerRef.current!, {
        width: containerRef.current!.clientWidth,
        height: 400,
        layout: {
          background: { color: "transparent" },
          textColor: "#9CA3AF",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.03)" },
          horzLines: { color: "rgba(255,255,255,0.03)" },
        },
        crosshair: {
          mode: lc.CrosshairMode.Normal,
        },
        rightPriceScale: {
          borderColor: "rgba(255,255,255,0.1)",
        },
        timeScale: {
          borderColor: "rgba(255,255,255,0.1)",
          timeVisible: true,
        },
      });

      chartRef.current = chart;

      const candleSeries = chart.addSeries(lc.CandlestickSeries, {
        upColor: "#22C55E",
        downColor: "#EF4444",
        borderDownColor: "#EF4444",
        borderUpColor: "#22C55E",
        wickDownColor: "#EF4444",
        wickUpColor: "#22C55E",
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const candleSeriesData = candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      candleSeries.setData(candleSeriesData as any);

      const volumeSeries = chart.addSeries(lc.HistogramSeries, {
        priceFormat: { type: "volume" as const },
        priceScaleId: "volume",
      });

      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const volumeData = candles.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? "rgba(34,197,94,0.2)" : "rgba(239,68,68,0.2)",
      }));
      volumeSeries.setData(volumeData as any);

      for (const [key, color] of Object.entries(MA_COLORS)) {
        const data = indicators[key as keyof typeof indicators];
        if (!data) continue;

        const lineData = candles
          .map((c, i) => ({ time: c.time, value: data[i] }))
          .filter((d): d is { time: number; value: number } => d.value !== null);

        if (lineData.length > 0) {
          const line = chart.addSeries(lc.LineSeries, {
            color,
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          line.setData(lineData as any);
        }
      }

      chart.timeScale().fitContent();

      const resize = () => {
        if (containerRef.current && chartRef.current) {
          chartRef.current.applyOptions({
            width: containerRef.current.clientWidth,
          });
        }
      };
      window.addEventListener("resize", resize);

      return () => {
        window.removeEventListener("resize", resize);
      };
    });

    return () => {
      mounted = false;
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [candles, indicators]);

  return (
    <div>
      <div ref={containerRef} className="w-full" />
      <div className="flex flex-wrap gap-3 mt-2 px-1">
        {Object.entries(MA_COLORS).map(([key, color]) => (
          <div key={key} className="flex items-center gap-1.5">
            <div
              className="w-3 h-0.5 rounded"
              style={{ backgroundColor: color }}
            />
            <span className="text-[10px] text-gray-500 uppercase">
              {key.replace("ma", "MA ").replace("ema", "EMA ")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
