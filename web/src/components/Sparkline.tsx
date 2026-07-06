interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Minimal dependency-free inline SVG sparkline. Colours by net direction over the
 * window (up = good, down = loss), matching the terminal palette. Renders nothing
 * until there are at least two samples.
 */
export function Sparkline({ data, width = 72, height = 20, className }: SparklineProps) {
  if (data.length < 2) {
    return (
      <svg width={width} height={height} className={className} aria-hidden>
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          className="stroke-line"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      </svg>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 2;
  const innerH = height - pad * 2;
  const stepX = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = pad + innerH - ((v - min) / span) * innerH;
    return [x, y] as const;
  });
  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

  const up = data[data.length - 1]! >= data[0]!;
  // Terminal palette: good (#22d3aa) / loss (#ff5470) from tailwind.config.ts.
  const stroke = up ? "#22d3aa" : "#ff5470";
  const [lastX, lastY] = points[points.length - 1]!;

  return (
    <svg width={width} height={height} className={className} aria-hidden>
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={1.6} fill={stroke} />
    </svg>
  );
}
