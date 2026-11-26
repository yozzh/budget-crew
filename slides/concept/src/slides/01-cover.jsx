import { AccentRule, StaggerContainer, StaggerItem } from '@/components/SlideTransition';

export default function Cover() {
  return (
    <div className="slide-page flex flex-col" data-viz-id="s1">
      <header className="shrink-0 flex items-center justify-between">
        <span data-viz-id="s1.brand" className="font-display text-h3 font-bold text-text-primary">Budget Crew</span>
        <span data-viz-id="s1.kind" className="text-eyebrow tracking-eyebrow uppercase font-bold text-text-muted">JigJoy Black Friday AI Hackathon 2026</span>
      </header>
      <div className="flex-1 min-h-0 flex flex-col justify-center">
        <span data-viz-id="s1.eyebrow" className="text-eyebrow tracking-eyebrow uppercase font-bold text-primary-500">AI agents in personal finance</span>
        <h1 data-viz-id="s1.title" className="mt-4 text-display font-display font-bold text-text-primary max-w-[980px]">
          Your daily budget, run by a <span data-viz-id="s1.title.accent" className="text-primary-500">crew</span> of AI agents
        </h1>
        <AccentRule className="mt-8" data-viz-id="s1.rule" />
        <p data-viz-id="s1.lead" className="mt-8 text-lead font-light text-text-secondary max-w-[760px]">
          One number for today, re-planned after every euro. Ten agents check each expense and every “can I buy?” at the same time.
        </p>
      </div>
      <StaggerContainer className="shrink-0 flex items-center gap-8 text-small text-text-muted">
        <StaggerItem data-viz-id="s1.footer.repo">github.com/yozzh/budget-crew</StaggerItem>
        <StaggerItem data-viz-id="s1.footer.stack">Built on @mozaik-ai/core</StaggerItem>
        <StaggerItem data-viz-id="s1.footer.data">Synthetic data only</StaggerItem>
      </StaggerContainer>
    </div>
  );
}
