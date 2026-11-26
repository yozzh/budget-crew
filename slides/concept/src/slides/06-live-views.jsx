import { AccentRule } from '@/components/SlideTransition';
import basicWorking from '@/assets/shots/basic-working.webp';
import basicJudge from '@/assets/shots/basic-judge.webp';
import proDone from '@/assets/shots/pro-done.webp';

// Captured on the live stand (live models) on 26 Nov 2026 for one request:
// "Can I buy a Nintendo Switch for €279?"
function Shot({ id, src, alt, caption }) {
  return (
    <figure data-viz-id={`live.${id}`} className="flex flex-col min-h-0">
      <img src={src} alt={alt} className="w-full rounded-lg border border-border-subtle shadow-md" />
      <figcaption className="mt-3 text-small text-text-secondary">{caption}</figcaption>
    </figure>
  );
}

export default function LiveViews() {
  return (
    <div className="slide-page flex flex-col" data-viz-id="live">
      <header className="shrink-0">
        <span data-viz-id="live.eyebrow" className="text-eyebrow tracking-eyebrow uppercase font-bold text-primary-500">Live on the stand</span>
        <h2 data-viz-id="live.title" className="mt-3 text-h1 font-display font-bold text-text-primary">
          Basic shows the answer, <span className="text-primary-500">Pro shows the work</span>
        </h2>
        <AccentRule className="mt-5" data-viz-id="live.rule" />
      </header>
      <div className="flex-1 min-h-0 mt-6 grid grid-cols-[0.95fr_1.05fr] gap-6 items-start">
        <div className="flex flex-col gap-4">
          <Shot id="working" src={basicWorking} alt="Basic mode: four advisers checking at once" caption="Basic · four advisers check the question at once" />
          <Shot id="judge" src={basicJudge} alt="Basic mode: Judge says Skip with figures" caption="Basic · Judge says Skip, with the figures behind it" />
        </div>
        <Shot id="pro" src={proDone} alt="Pro mode: agent cards and the concurrency timeline" caption="Pro · every agent’s verdict and the overlapping loops on one timeline" />
      </div>
      <p data-viz-id="live.note" className="shrink-0 mt-4 text-small text-text-muted">
        One live request on 26 November: “Can I buy a Nintendo Switch for €279?” with €251 left for 5 days.
      </p>
    </div>
  );
}
