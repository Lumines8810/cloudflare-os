import {
  ChartBar,
  SealCheck,
  ShoppingCart,
  type Icon,
} from '@phosphor-icons/react'

// A few example work tasks shown under the Home composer, so a new user immediately sees the kind
// of thing they can ask for. Picking one drops a starter prompt into the composer (it does not
// auto-send) so the user can tweak it before running.
type TaskSuggestion = {
  id: string
  label: string
  description: string
  prompt: string
  icon: Icon
}

// SOLAS work tasks (costing, sourcing, brand review), one per blueprint this deployment ships, in
// place of the upstream generic examples. Each prompt keeps the human-review stop the SOLAS
// blueprints require: provisional figures stay provisional, and nothing is saved unasked.
const SUGGESTIONS: TaskSuggestion[] = [
  {
    id: 'costing',
    label: 'ロット別の原価を比較する',
    description: 'BOM版とロット数を固定して、仮計算と判断用計算を並べる',
    icon: ChartBar,
    prompt:
      'BOM-001 rev.3 を100・500・1,000個で原価比較して。固定費が未確定なら判断用計算は止めて。',
  },
  {
    id: 'sourcing',
    label: '見積の改訂を記録する',
    description: '仕入先・見積ID・有効期限を案件に紐づける',
    icon: ShoppingCart,
    prompt:
      '山田精密からの見積改訂（quoteRef: Q-2026-114 rev.2）を案件 SOLAS-2026-001 に記録して。',
  },
  {
    id: 'brand',
    label: '制作提案をブランド検査にかける',
    description: '文章・色・書体・素材IDの宣言だけを決定的に検査',
    icon: SealCheck,
    prompt:
      '保存済みのブランド版に対して、パッケージ提案の文章と色・書体を検査して。保存はしないで。',
  },
]

// One row, shared by every suggestion so the list reads as one kind of offer.
function SuggestionRow({
  icon,
  label,
  description,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  description: string
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="press group flex w-full cursor-pointer items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-kumo-tint"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle transition-colors group-hover:text-kumo-default">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
            {label}
          </span>
          <span className="block truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
            {description}
          </span>
        </span>
      </button>
    </li>
  )
}

export default function HomeTaskSuggestions({
  onPick,
}: {
  onPick: (prompt: string) => void
}) {
  return (
    <section aria-label="Example tasks" className="flex flex-col gap-1">
      <h3 className="px-1 pb-1 text-[12px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
        Get started
      </h3>
      <ul className="flex flex-col gap-0.5">
        {SUGGESTIONS.map((suggestion) => (
          <SuggestionRow
            key={suggestion.id}
            icon={<suggestion.icon size={16} />}
            label={suggestion.label}
            description={suggestion.description}
            onClick={() => onPick(suggestion.prompt)}
          />
        ))}
      </ul>
    </section>
  )
}
