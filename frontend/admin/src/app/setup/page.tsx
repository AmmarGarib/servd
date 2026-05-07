import { OnboardingChecklist } from '../../components/dashboard/OnboardingChecklist'

export default function SetupPage() {
  return (
    <div className="min-h-screen bg-kds-bg">
      <header className="border-b border-kds-border px-6 py-4">
        <h1 className="text-2xl font-black text-kds-text">First-run setup</h1>
        <p className="text-sm text-kds-subtext mt-0.5">
          Walk through the basics. Each tile takes you to the page to finish that step.
        </p>
      </header>
      <div className="p-6 max-w-5xl">
        <OnboardingChecklist forceShow />
      </div>
    </div>
  )
}
