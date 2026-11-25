import HsiPanel from "../components/HsiPanel";

export default function MarketDataPage() {
  return (
    <main
      className="dashboard mx-auto min-h-[100dvh] w-full max-w-none overflow-visible bg-[var(--bg)] px-3 text-[var(--text)] sm:px-4 md:px-6 lg:px-8 xl:h-[calc(100dvh-3.5625rem)] xl:min-h-0 xl:overflow-hidden"
      style={{ paddingTop: "0.75rem", paddingBottom: "0.75rem" }}
    >
      <div className="min-w-0 xl:h-full">
        <section className="card flex min-w-0 flex-col p-3 sm:p-5 xl:h-full xl:min-h-0">
          <div className="min-w-0 xl:min-h-0 xl:flex-1">
            <HsiPanel refreshToken={0} dataMode="futu" />
          </div>
        </section>
      </div>
    </main>
  );
}
