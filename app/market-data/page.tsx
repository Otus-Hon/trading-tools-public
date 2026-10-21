import HsiPanel from "../components/HsiPanel";
import MarketMiniCharts from "../components/MarketMiniCharts";

export default function MarketDataPage() {
  return (
    <main
      className="dashboard mx-auto h-[calc(100dvh-3.5625rem)] w-full max-w-none overflow-hidden bg-[var(--bg)] px-4 text-[var(--text)] md:px-6 lg:px-8"
      style={{ paddingTop: "0.75rem", paddingBottom: "0.75rem" }}
    >
      <div className="grid h-full grid-cols-1 gap-5 xl:grid-cols-[minmax(0,74fr)_minmax(360px,26fr)]">
        <section className="card flex min-h-[520px] flex-col lg:h-full lg:min-h-0">
          <div className="min-h-[480px] flex-1 lg:min-h-0">
            <HsiPanel refreshToken={0} dataMode="futu" />
          </div>
        </section>
        <MarketMiniCharts />
      </div>
    </main>
  );
}
