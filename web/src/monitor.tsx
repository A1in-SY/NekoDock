import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  BrushComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsType } from "echarts/core";
import type { MetricSample, PublicBot } from "../../src/console/contracts";
import { api, errorText } from "./api";
import { date, ErrorBox, Icon } from "./ui";
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  ToolboxComponent,
  BrushComponent,
  CanvasRenderer,
]);

type Range = { from: number; to: number; relative: number | null };
type Metric = "cpu" | "memory" | "network" | "latency";
const quick: [number, string][] = [
  [5, "Last 5 minutes"],
  [15, "Last 15 minutes"],
  [30, "Last 30 minutes"],
  [60, "Last 1 hour"],
  [180, "Last 3 hours"],
  [360, "Last 6 hours"],
  [720, "Last 12 hours"],
  [1440, "Last 24 hours"],
  [2880, "Last 2 days"],
  [10080, "Last 7 days"],
];
const metrics: [Metric, string, string][] = [
  ["cpu", "CPU 使用率", "100% 表示占满一个 CPU 核心"],
  ["memory", "内存工作集", "容器内存使用量，扣除可回收缓存"],
  ["network", "网络吞吐量", "接收与发送速率"],
  ["latency", "消息处理耗时 · P95", "从触发消息收到，到最后一次发送确认"],
];
const colors = [
  "#629b86",
  "#9882bd",
  "#cc9b6c",
  "#7e9db7",
  "#b87e89",
  "#98aa67",
];
function relativeRange(minutes: number): Range {
  const to = Date.now();
  return { from: to - minutes * 60000, to, relative: minutes };
}
function rangeLabel(range: Range) {
  return range.relative != null
    ? quick.find(([n]) => n === range.relative)?.[1] ||
        "Last " + range.relative + " minutes"
    : date(range.from, { year: undefined }) +
        " — " +
        date(range.to, { year: undefined });
}
function parseTime(value: string, now: number): number {
  if (value === "now") return now;
  const match = /^now-(\d+(?:\.\d+)?)(s|m|h|d|w)$/.exec(value);
  if (match)
    return (
      now -
      Number(match[1]) *
        ({ s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[
          match[2]!
        ] || 0)
    );
  const normalized = value.trim().replace(" ", "T");
  const time = Date.parse(
    /Z|[+-]\d\d:\d\d$/.test(normalized) ? normalized : normalized + "+08:00",
  );
  if (!Number.isFinite(time))
    throw new Error("请输入有效时间，例如 now-1h 或 2026-10-24 12:00:00。");
  return time;
}
export function Monitor({ bots }: { bots: PublicBot[] }) {
  const [range, setRange] = useState<Range>(() => relativeRange(60));
  const [samples, setSamples] = useState<MetricSample[]>([]);
  const [peaks, setPeaks] = useState<MetricSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState(false);
  const [ratesOpen, setRatesOpen] = useState(false);
  const [rate, setRate] = useState(15);
  const [updated, setUpdated] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Metric | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [step, setStep] = useState(15000);
  const request = useRef(0);
  const load = useCallback(async () => {
    const seq = ++request.current;
    try {
      const result = await api<{
        samples: MetricSample[];
        peaks?: MetricSample[];
        step: number;
      }>(
        "/api/metrics?from=" +
          Math.round(range.from) +
          "&to=" +
          Math.round(range.to),
      );
      if (seq !== request.current) return;
      setSamples(result.samples);
      setPeaks(result.peaks ?? []);
      setStep(result.step);
      setError("");
      setUpdated(Date.now());
    } catch (error) {
      if (seq === request.current) setError(errorText(error));
    } finally {
      if (seq === request.current) setLoading(false);
    }
  }, [range.from, range.to]);
  useEffect(() => {
    void load();
  }, [load, refreshNonce]);
  const refresh = useCallback(() => {
    if (range.relative != null) setRange(relativeRange(range.relative));
    else setRefreshNonce((n) => n + 1);
  }, [range.relative]);
  useEffect(() => {
    if (!rate) return;
    const timer = setInterval(refresh, rate * 1000);
    return () => clearInterval(timer);
  }, [rate, refresh]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExpanded(null);
        setPicker(false);
        setRatesOpen(false);
      }
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);
  const zoom = (from: number, to: number) => {
    if (to - from < 1000) return;
    setRange({ from: Math.round(from), to: Math.round(to), relative: null });
  };
  const zoomOut = () => {
    const width = range.to - range.from;
    const center = (range.from + range.to) / 2;
    const to = Math.min(Date.now(), center + width);
    setRange({ from: Math.max(0, to - width * 2), to, relative: null });
  };
  const reset = () => setRange(relativeRange(60));
  return (
    <div className="mon-root">
      <header className="mon-heading">
        <div>
          <h1>监控</h1>
          <p>在同一个时间范围内查看实例的资源与消息处理情况。</p>
        </div>
      </header>
      <section className="mon-controls">
        <div className="mon-time-row">
          <div className="mon-range-control">
            <div className="mon-button-group">
              <button
                className="mon-button mon-range-trigger"
                aria-expanded={picker}
                onClick={() => {
                  setPicker((v) => !v);
                  setRatesOpen(false);
                }}
              >
                <Icon name="clock" />
                {rangeLabel(range)}
                <Icon name="down" />
              </button>
              <button
                className="mon-button mon-zoom-out"
                title="扩大时间范围"
                aria-label="扩大时间范围"
                onClick={zoomOut}
              >
                <Icon name="search" />
              </button>
            </div>
            {picker && (
              <RangePicker
                range={range}
                onClose={() => setPicker(false)}
                onApply={(r) => {
                  setRange(r);
                  setPicker(false);
                }}
              />
            )}
          </div>
          <div className="mon-refresh-controls mon-button-group">
            <button
              className="mon-button mon-refresh-trigger"
              disabled={loading}
              onClick={refresh}
            >
              <Icon name="refresh" />
              Refresh
              {rate > 0 && <span className="mon-rate-badge">{rate}s</span>}
            </button>
            <button
              className="mon-button mon-refresh-menu-trigger"
              aria-label="自动刷新间隔"
              aria-expanded={ratesOpen}
              onClick={() => {
                setRatesOpen((v) => !v);
                setPicker(false);
              }}
            >
              <Icon name="down" />
            </button>
            {ratesOpen && (
              <div className="mon-refresh-menu">
                <span>自动刷新</span>
                {[0, 5, 15, 30, 60].map((n) => (
                  <button
                    key={n}
                    className={rate === n ? "mon-option-selected" : ""}
                    onClick={() => {
                      setRate(n);
                      setRatesOpen(false);
                    }}
                  >
                    {n === 0 ? "关闭" : n < 60 ? n + " 秒" : "1 分钟"}
                    {rate === n && <Icon name="check" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
      {error && <ErrorBox error={error} retry={() => void load()} />}
      <div className="mon-chart-toolbar">
        <span>拖动图表可缩放时间范围，悬停可对照同一时刻。</span>
        <div>
          <span className="mon-refreshed">
            {updated
              ? "更新于 " +
                date(updated, {
                  year: undefined,
                  month: undefined,
                  day: undefined,
                })
              : loading
                ? "正在采集…"
                : "尚无数据"}{" "}
            · UTC+8
          </span>
          <button className="mon-button mon-reset" onClick={reset}>
            <Icon name="refresh" />
            重置缩放
          </button>
        </div>
      </div>
      <div className="mon-grid">
        {metrics.map(([key, title, subtitle]) => (
          <section className="mon-panel" key={key}>
            <header className="mon-panel-head">
              <div>
                <h2>{title}</h2>
                <p>{subtitle}</p>
              </div>
              <button
                className="mon-icon-button"
                aria-label={"放大" + title}
                onClick={() => setExpanded(key)}
              >
                <Icon name="eye" />
              </button>
            </header>
            <Chart
              metric={key}
              bots={bots}
              samples={samples}
              peaks={peaks}
              range={range}
              onZoom={zoom}
            />
          </section>
        ))}
      </div>
      <p className="mon-footnote">
        {loading
          ? "正在加载指标。"
          : !samples.length
            ? "此时间范围尚无采样数据。"
            : `当前查询分辨率 ${Math.round(step / 1000)} 秒。`}
        停止、断连或采集失败的时段显示为空缺。
      </p>
      {expanded && (
        <div
          className="mon-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setExpanded(null);
          }}
        >
          <section
            className="mon-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={metrics.find(([key]) => key === expanded)?.[1]}
          >
            <header className="mon-dialog-head">
              <div>
                <h2>{metrics.find(([key]) => key === expanded)?.[1]}</h2>
                <span>{rangeLabel(range)} · UTC+08:00</span>
              </div>
              <div>
                <button className="mon-button mon-reset" onClick={reset}>
                  <Icon name="refresh" />
                  重置缩放
                </button>
                <button
                  className="mon-icon-button"
                  aria-label="关闭放大图表"
                  onClick={() => setExpanded(null)}
                >
                  <Icon name="close" />
                </button>
              </div>
            </header>
            <div className="mon-panel mon-expanded-panel">
              <Chart
                metric={expanded}
                bots={bots}
                samples={samples}
                peaks={peaks}
                range={range}
                expanded
                onZoom={zoom}
              />
            </div>
            <footer>点击图例隐藏或显示曲线，拖动图表缩放时间范围。</footer>
          </section>
        </div>
      )}
    </div>
  );
}
function RangePicker({
  range,
  onApply,
  onClose,
}: {
  range: Range;
  onApply: (range: Range) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(
    range.relative != null
      ? "now-" + range.relative + "m"
      : date(range.from).replace(/\//g, "-"),
  );
  const [to, setTo] = useState(
    range.relative != null ? "now" : date(range.to).replace(/\//g, "-"),
  );
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (
        !root.current?.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest(".mon-range-trigger")
      )
        onClose();
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);
  const apply = () => {
    try {
      const now = Date.now(),
        start = parseTime(from.trim(), now),
        end = parseTime(to.trim(), now);
      if (start >= end) throw new Error("From 必须早于 To。");
      if (end - start > 31 * 86400000) throw new Error("一次最多查询 31 天。");
      onApply({ from: start, to: end, relative: null });
    } catch (error) {
      setError(errorText(error));
    }
  };
  return (
    <div className="mon-time-picker" ref={root}>
      <div className="mon-time-picker-body">
        <div className="mon-absolute-range">
          <h2>Absolute time range</h2>
          <TimeField label="From" value={from} setValue={setFrom} />
          <TimeField label="To" value={to} setValue={setTo} />
          <button className="mon-button mon-apply-range" onClick={apply}>
            Apply time range
          </button>
          <p className="mon-custom-error" role="alert">
            {error}
          </p>
        </div>
        <div className="mon-quick-ranges">
          <div className="mon-range-search">
            <Icon name="search" />
            <input
              placeholder="Search quick ranges"
              aria-label="搜索快捷时间范围"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="mon-quick-list">
            {quick
              .filter(([, label]) =>
                label.toLowerCase().includes(search.toLowerCase()),
              )
              .map(([minutes, label]) => (
                <button
                  key={minutes}
                  className={
                    range.relative === minutes ? "mon-option-selected" : ""
                  }
                  onClick={() => onApply(relativeRange(minutes))}
                >
                  {label}
                </button>
              ))}
          </div>
        </div>
      </div>
      <footer>
        <span>
          Browser Time <strong>China, CST</strong>
        </span>
        <span className="mon-timezone">UTC+08:00</span>
      </footer>
    </div>
  );
}
function TimeField({
  label,
  value,
  setValue,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
}) {
  const calendar = useRef<HTMLInputElement>(null);
  return (
    <label className="mon-time-field">
      {label}
      <span className="mon-time-input-wrap">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={label}
        />
        <button
          className="mon-calendar-button"
          type="button"
          aria-label={label + " 日历"}
          onClick={() => calendar.current?.showPicker()}
        >
          <Icon name="calendar" />
        </button>
        <input
          type="datetime-local"
          className="mon-calendar-input"
          tabIndex={-1}
          ref={calendar}
          onChange={(e) => {
            if (e.target.value) setValue(e.target.value.replace("T", " "));
          }}
        />
      </span>
    </label>
  );
}
function Chart({
  metric,
  bots,
  samples,
  peaks,
  range,
  expanded = false,
  onZoom,
}: {
  metric: Metric;
  bots: PublicBot[];
  samples: MetricSample[];
  peaks: MetricSample[];
  range: Range;
  expanded?: boolean;
  onZoom: (from: number, to: number) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsType | null>(null);
  const selected = useRef<Record<string, boolean>>({});
  const zoom = useRef(onZoom);
  zoom.current = onZoom;
  const bounds = useRef(range);
  bounds.current = range;
  const series = useMemo(() => {
    const all: Array<{
      name: string;
      color: string;
      data: Array<[number, number | null]>;
      peaks: Map<number, number | null>;
    }> = [];
    for (let index = 0; index < bots.length; index++) {
      const bot = bots[index]!;
      const rows = samples
        .filter((s) => s.botId === bot.id)
        .sort((a, b) => a.time - b.time);
      const color = colors[index % colors.length]!;
      const peakRows = peaks.filter((s) => s.botId === bot.id);
      if (metric === "network") {
        all.push(
          {
            name: bot.name + " · 接收",
            color,
            data: rows.map((s) => [s.time, s.rx]),
            peaks: new Map(peakRows.map((s) => [s.time, s.rx])),
          },
          {
            name: bot.name + " · 发送",
            color,
            data: rows.map((s) => [s.time, s.tx]),
            peaks: new Map(peakRows.map((s) => [s.time, s.tx])),
          },
        );
      } else
        all.push({
          name: bot.name,
          color,
          data: rows.map((s) => [s.time, s[metric]]),
          peaks: new Map(peakRows.map((s) => [s.time, s[metric]])),
        });
    }
    return all;
  }, [bots, samples, peaks, metric]);
  useEffect(() => {
    if (!element.current) return;
    const instance = echarts.init(element.current, undefined, {
      renderer: "canvas",
    });
    chart.current = instance;
    instance.group = "napcat-metrics";
    echarts.connect("napcat-metrics");
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(element.current);
    instance.on("legendselectchanged", (event: unknown) => {
      selected.current = (
        event as { selected: Record<string, boolean> }
      ).selected;
    });
    instance.on("datazoom", (event: unknown) => {
      const e = event as {
        start?: number;
        end?: number;
        batch?: Array<{
          start?: number;
          end?: number;
          startValue?: number;
          endValue?: number;
        }>;
      };
      const v =
        e.batch?.[0] ||
        (e as {
          start?: number;
          end?: number;
          startValue?: number;
          endValue?: number;
        });
      const r = bounds.current;
      const from =
          v.startValue ?? r.from + ((r.to - r.from) * (v.start ?? 0)) / 100,
        to = v.endValue ?? r.from + ((r.to - r.from) * (v.end ?? 100)) / 100;
      if (Math.abs(from - r.from) > 100 || Math.abs(to - r.to) > 100)
        zoom.current(from, to);
    });
    return () => {
      resize.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const formatter = (v: number) =>
      metric === "cpu"
        ? v.toFixed(v < 10 ? 1 : 0) + "%"
        : metric === "memory"
          ? v.toFixed(v < 10 ? 1 : 0) + " MiB"
          : metric === "network"
            ? v.toFixed(v < 10 ? 1 : 0) + " KiB/s"
            : v < 1
              ? Math.round(v * 1000) + " ms"
              : v.toFixed(1) + " s";
    instance.setOption(
      {
        animation: false,
        textStyle: {
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
        },
        grid: { left: 58, right: 16, top: 14, bottom: 63 },
        tooltip: {
          renderMode: "richText",
          trigger: "axis",
          confine: true,
          backgroundColor: "#fffef8f5",
          borderColor: "#e2e6df",
          textStyle: { color: "#6e7d76", fontSize: 10 },
          axisPointer: {
            type: "line",
            lineStyle: { color: "#82978c", type: "dashed" },
          },
          valueFormatter: (v: unknown) =>
            v == null ? "—" : formatter(Number(v)),
          formatter: (value: unknown) => {
            const params = (Array.isArray(value) ? value : [value]) as Array<{
              seriesName: string;
              seriesIndex: number;
              data: [number, number | null];
            }>;
            if (!params.length) return "";
            return [
              date(params[0]!.data[0]),
              ...params.map((p) => {
                const peak = series[p.seriesIndex]?.peaks.get(p.data[0]);
                const label = metric === "latency" ? "P95" : "平均";
                return `${p.seriesName}  ${label} ${p.data[1] == null ? "—" : formatter(p.data[1])}${peak == null ? "" : ` · 峰值 ${formatter(peak)}`}`;
              }),
            ].join("\n");
          },
        },
        legend: {
          selected: selected.current,
          bottom: 0,
          type: "scroll",
          textStyle: { fontSize: 10, color: "#8d9a94" },
          icon: "roundRect",
          itemWidth: 15,
          itemHeight: 3,
        },
        xAxis: {
          type: "time",
          min: range.from,
          max: range.to,
          boundaryGap: false,
          axisLabel: {
            color: "#a6afb6",
            fontSize: 9,
            formatter: (v: number) =>
              new Intl.DateTimeFormat("zh-CN", {
                timeZone: "Asia/Shanghai",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              }).format(v),
            hideOverlap: true,
          },
          axisLine: { lineStyle: { color: "#e5ebe7" } },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          min: 0,
          axisLabel: { color: "#a6afb6", fontSize: 9, formatter },
          splitLine: { lineStyle: { color: "#edf0f2", type: "dashed" } },
        },
        // ECharts creates the drag-selection controller while rendering this feature.
        toolbox: {
          show: true,
          left: -100,
          top: -100,
          itemSize: 0,
          showTitle: false,
          feature: { dataZoom: { yAxisIndex: "none" } },
        },
        dataZoom: [
          {
            type: "inside",
            xAxisIndex: 0,
            filterMode: "none",
            zoomOnMouseWheel: false,
            moveOnMouseMove: false,
            moveOnMouseWheel: false,
          },
        ],
        series: series.map((s, index) => ({
          name: s.name,
          type: "line",
          data: s.data,
          showSymbol: false,
          connectNulls: false,
          lineStyle: {
            width: 1.7,
            color: s.color,
            type: metric === "network" && index % 2 ? "dashed" : "solid",
          },
          itemStyle: { color: s.color },
          emphasis: { focus: "series" },
        })),
        graphic: series.some((s) => s.data.some(([, v]) => v != null))
          ? []
          : [
              {
                type: "text",
                left: "center",
                top: "40%",
                style: { text: "暂无采样数据", fill: "#a0aca5", fontSize: 12 },
              },
            ],
      },
      true,
    );
    instance.dispatchAction({
      type: "takeGlobalCursor",
      key: "dataZoomSelect",
      dataZoomSelectActive: true,
    });
  }, [series, range.from, range.to, metric]);
  return (
    <div
      ref={element}
      className={"echart " + (expanded ? "expanded" : "")}
      role="img"
      aria-label={metrics.find(([key]) => key === metric)?.[1] + "时间序列图表"}
    />
  );
}
