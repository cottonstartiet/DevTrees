import type { CopilotAnalyticsSummary } from '@shared/copilot-analytics'
import { CostByModelChart, TokenMixChart } from './charts'
import { Section } from './shared'

export function UsageBreakdowns({
  summary
}: {
  summary: CopilotAnalyticsSummary
}): React.JSX.Element {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {summary.coverage.sources.map(({ source }) => {
        return (
          <Section
            key={source}
            title="Token mix"
            description="Recorded input, output and cache token fields."
          >
            <TokenMixChart summary={summary} />
          </Section>
        )
      })}
      <Section title="Cost by model" description="Recorded Copilot CLI AI credits per model.">
        <CostByModelChart summary={summary} />
      </Section>
    </div>
  )
}
