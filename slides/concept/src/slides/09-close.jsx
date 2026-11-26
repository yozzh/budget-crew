export default function Close() {
  return (
    <div className="slide-page !bg-bg-ink flex flex-col" data-viz-id="s9">
      <span data-viz-id="s9.eyebrow" className="text-eyebrow tracking-eyebrow uppercase font-bold text-ink-300">Budget Crew</span>
      <div className="flex-1 min-h-0 flex flex-col justify-center">
        <h2 data-viz-id="s9.title" className="text-display font-display font-bold text-text-inverse max-w-[900px]">
          Know your number. Ask your crew before you buy.
        </h2>
        <div className="mt-12 grid grid-cols-[1.3fr_1fr_1fr] gap-10">
          <div data-viz-id="s9.repo">
            <p className="text-eyebrow tracking-eyebrow uppercase font-bold text-ink-300">Code</p>
            <p className="mt-2 text-lead text-text-inverse">github.com/yozzh/budget-crew</p>
          </div>
          <div data-viz-id="s9.stack">
            <p className="text-eyebrow tracking-eyebrow uppercase font-bold text-ink-300">Built with</p>
            <p className="mt-2 text-lead text-text-inverse">Mozaik, NestJS, Centrifugo, React</p>
          </div>
          <div data-viz-id="s9.data">
            <p className="text-eyebrow tracking-eyebrow uppercase font-bold text-ink-300">Data</p>
            <p className="mt-2 text-lead text-text-inverse">Synthetic only. Not financial advice.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
