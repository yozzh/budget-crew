import { useId } from "react";
import type { Period } from "@budget-crew/shared";
import { allowanceChartData } from "./chart.js";

const euros = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dateLabel = (value: string) => date.format(new Date(`${value}T00:00:00Z`));

export function AllowanceChart({ period, today }: { period: Period | undefined; today: string | undefined }) {
  const titleId = useId();
  const descriptionId = useId();
  const points = allowanceChartData(period);
  const current = points.findIndex((point) => point.date === today);
  const width = 900;
  const height = 260;
  const left = 80;
  const right = width - 28;
  const top = 20;
  const bottom = height - 42;
  let low = 0;
  let high = 1;
  for (const point of points) {
    low = Math.min(low, point.planned, point.actual);
    high = Math.max(high, point.planned, point.actual);
  }
  const x = (index: number) => left + (right - left) * index / Math.max(1, points.length - 1);
  const y = (amount: number) => bottom - (bottom - top) * (amount - low) / (high - low);
  const path = (key: "planned" | "actual") => points.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point[key])}`).join(" ");
  const ticks = [low, (low + high) / 2, high];

  return <section className="allowance-chart" aria-labelledby={titleId}>
    <div className="section-title"><h2 id={titleId}>Daily allowance · EUR</h2><span className="quiet-label">Full open-period projection</span></div>
    <ul className="chart-legend" aria-label="Chart legend"><li><span className="legend-line planned" aria-hidden="true" />Planned baseline</li><li><span className="legend-line actual" aria-hidden="true" />Actual projection</li></ul>
    {points.length ? <>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${titleId} ${descriptionId}`}>
        <desc id={descriptionId}>Daily allowance in euros from {dateLabel(points[0]!.date)} to {dateLabel(points.at(-1)!.date)}. The dashed planned baseline excludes extra income and spending changes; the solid actual projection includes them for every day. {current >= 0 ? `Current simulated day: ${dateLabel(points[current]!.date)}.` : ""}</desc>
        {ticks.map((amount, index) => <g key={index}><line className="chart-grid" x1={left} x2={right} y1={y(amount)} y2={y(amount)} /><text className="chart-label" x={left - 10} y={y(amount) + 4} textAnchor="end">{euros.format(amount)}</text></g>)}
        <path className="chart-series planned" d={path("planned")} />
        <path className="chart-series actual" d={path("actual")} />
        {current >= 0 && <g><line className="chart-current" x1={x(current)} x2={x(current)} y1={top} y2={bottom} /><circle className="chart-current-point" cx={x(current)} cy={y(points[current]!.actual)} r="4"><title>{dateLabel(points[current]!.date)}: {euros.format(points[current]!.actual)}</title></circle></g>}
        {points.length === 1 && <circle className="chart-current-point" cx={x(0)} cy={y(points[0]!.actual)} r="4" />}
        <text className="chart-label" x={left} y={height - 12}>{dateLabel(points[0]!.date)}</text>
        {points.length > 1 && <text className="chart-label" x={right} y={height - 12} textAnchor="end">{dateLabel(points.at(-1)!.date)}</text>}
      </svg>
      <details className="chart-data"><summary>View daily allowance values</summary><div className="chart-table-scroll"><table><caption>Daily allowances in euros</caption><thead><tr><th scope="col">Date</th><th scope="col">Planned baseline</th><th scope="col">Actual projection</th></tr></thead><tbody>{points.map((point) => <tr key={point.date} aria-current={point.date === today ? "date" : undefined}><th scope="row">{dateLabel(point.date)}</th><td>{euros.format(point.planned)}</td><td>{euros.format(point.actual)}</td></tr>)}</tbody></table></div></details>
    </> : <p className="form-hint">Add a salary to see the daily plan for an open period.</p>}
  </section>;
}
